using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using Diagram.Ipc;

namespace Diagram.App;

/// <summary>
/// Serves outside clients (the MCP shim) over the user's pipe. It offers the document tools only: open, save, replace and the
/// other lifecycle methods stay inside the application, so no client can reach the file system or the editor's session through here.
/// Every request is forwarded to the page with a host-stamped origin, and the page decides ordering, admission and revisions.
/// </summary>
public sealed class LiveControl : IAsyncDisposable
{
    static readonly HashSet<string> Offered = new()
    {
        "docs.list", "docs.create", "docs.importVisio", "docs.show", "doc.summary", "doc.getObjects", "doc.apply", "doc.executeScript", "doc.changes", "doc.inspectLayout", "doc.proposeRoutes", "doc.textLayout", "doc.render", "doc.export", "assets.list", "reference.render", "reference.compare", "icons.search", "icons.get", "components.list", "components.get",
    };

    /// <summary>Calls that may omit the scope because they are how a client first learns it.</summary>
    static readonly HashSet<string> ScopeOptional = new() { "doc.summary", "assets.list" };

    readonly BridgeRouter router;
    readonly PipeServer server;
    readonly Func<RequestEnvelope, CancellationToken, Task<ResponseEnvelope>> export;
    readonly AssetLibrary library;
    readonly AssetResolver resolver;
    readonly Func<RequestEnvelope, CancellationToken, Task<ResponseEnvelope>>? reference;
    readonly DocumentService? documents;

    public LiveControl(string pipeName, BridgeRouter router, Func<RequestEnvelope, CancellationToken, Task<ResponseEnvelope>> export, AssetLibrary library, AssetResolver resolver,
        Func<RequestEnvelope, CancellationToken, Task<ResponseEnvelope>>? reference = null, DocumentService? documents = null)
    {
        this.documents = documents;
        this.router = router;
        this.export = export;
        this.library = library;
        this.resolver = resolver;
        this.reference = reference;
        server = PipeServer.Start(pipeName, HandleAsync);
    }

    public PipeServer Server => server;

    async Task<ResponseEnvelope> HandleAsync(ConnectionInfo connection, RequestEnvelope request, CancellationToken ct)
    {
        if (!Offered.Contains(request.Method)) return Wire.Error(request.RequestId, "method_not_found", $"{request.Method} is not available to clients");
        var askedForCurrent = request.DocumentId is null && request.SessionId is null;
        if (ScopeOptional.Contains(request.Method) && request.DocumentId is null && request.SessionId is null && router.CurrentScope is { } scope)
            request = request with { DocumentId = scope.DocumentId, SessionId = scope.SessionId };
        if (request.Method.StartsWith("docs.", StringComparison.Ordinal)) return documents is null ? Wire.Error(request.RequestId, "not_ready", "document tools are unavailable") : await documents.HandleAsync(request, ct);
        if (request.Method == "doc.export") return await export(request, ct); // the host writes the file itself, inside the approved folders
        if (request.Method is "reference.render" or "reference.compare") return reference is null
            ? Wire.Error(request.RequestId, "not_ready", "reference rendering is unavailable") : await reference(request, ct);
        if (request.Method == "assets.list") return await ListAssetsAsync(request, ct);
        if (request.Method == "doc.executeScript") return await ExecuteScriptAsync(request, ct);
        if (request.Method == "doc.summary" && documents is not null && askedForCurrent) return await WithOtherDocumentsAsync(request, ct);
        return await router.SendAsync(request, ct);
    }

    /// <summary>The summary of the active document, plus the other open documents, so an agent that asked for "the document" learns there are more.</summary>
    async Task<ResponseEnvelope> WithOtherDocumentsAsync(RequestEnvelope request, CancellationToken ct)
    {
        var r = await router.SendAsync(request, ct);
        if (r.Error is not null || r.Result is not { } res || res.ValueKind != System.Text.Json.JsonValueKind.Object) return r;
        var all = await documents!.ListAsync(ct);
        if (all.Count < 2) return r;
        var o = JsonNode.Parse(res.GetRawText())!.AsObject();
        o["openDocuments"] = all;
        o["openDocumentsNote"] = "More than one document is open. Other tools address a document by the documentId and sessionId you pass; use list_documents for the current list.";
        return new ResponseEnvelope { RequestId = r.RequestId, Result = System.Text.Json.JsonSerializer.SerializeToElement(o) };
    }

    /// <summary>The document's pinned pictures and the library's, side by side. A document entry wins an exact id match and says if the library has moved on.</summary>
    async Task<ResponseEnvelope> ListAssetsAsync(RequestEnvelope request, CancellationToken ct)
    {
        var fromDoc = await router.SendAsync(request, ct);
        if (fromDoc.Error is not null || fromDoc.Result is not { } result) return fromDoc;
        var query = request.Params["query"]?.GetValue<string>();
        var tags = request.Params["tags"] is JsonArray t ? t.Select(x => x?.GetValue<string>() ?? "").ToArray() : null;
        var lib = await library.ListAsync(query, tags, ct);

        var merged = new JsonArray();
        var docIds = new HashSet<string>();
        foreach (var node in result.GetProperty("assets").EnumerateArray())
        {
            var o = JsonNode.Parse(node.GetRawText())!.AsObject();
            var id = o["id"]!.GetValue<string>();
            docIds.Add(id);
            o["scope"] = "document";
            var match = lib.FirstOrDefault(a => a.Id == id);
            if (match is not null)
            {
                o["inLibrary"] = true; o["libraryVersion"] = match.Version;
                if (!string.Equals(match.Sha256, o["sha256"]?.GetValue<string>(), StringComparison.Ordinal)) o["newerInLibrary"] = true;
            }
            merged.Add(o);
        }
        foreach (var a in lib.Where(a => !docIds.Contains(a.Id)))
            merged.Add(new JsonObject
            {
                ["id"] = a.Id, ["name"] = a.Name, ["mimeType"] = a.MimeType, ["sha256"] = a.Sha256, ["tags"] = new JsonArray(a.Tags.Select(x => (JsonNode)x).ToArray()),
                ["scope"] = "library", ["libraryVersion"] = a.Version, ["width"] = a.Width, ["height"] = a.Height, ["usedBy"] = 0,
            });
        var outObj = JsonNode.Parse(result.GetRawText())!.AsObject();
        outObj["assets"] = merged;
        return new ResponseEnvelope { RequestId = request.RequestId, Result = System.Text.Json.JsonSerializer.SerializeToElement(outObj) };
    }

    /// <summary>
    /// A client names library pictures (`libraryAssets`: "asset:logo" or "asset:logo@sha256"); the host resolves them to approved preparations.
    /// A client can never supply preparations itself: any `preparedAssetRefs` it sends is discarded.
    /// </summary>
    async Task<ResponseEnvelope> ExecuteScriptAsync(RequestEnvelope request, CancellationToken ct)
    {
        var p = request.Params.DeepClone().AsObject();
        p.Remove("preparedAssetRefs");
        var named = p["libraryAssets"] as JsonArray;
        p.Remove("libraryAssets");
        if (named is { Count: > 0 })
        {
            if (named.Count > 64) return Wire.Error(request.RequestId, "invalid_request", "libraryAssets takes at most 64 entries");
            var refs = new JsonObject();
            foreach (var item in named)
            {
                var spec = item?.GetValue<string>() ?? "";
                var at = spec.IndexOf('@');
                var id = at < 0 ? spec : spec[..at];
                var hash = at < 0 ? null : spec[(at + 1)..];
                var r = await resolver.ResolveAsync(id, "library", hash, ct);
                if (!r.IsOk) return new ResponseEnvelope { RequestId = request.RequestId, Error = r.Error };
                refs[spec] = System.Text.Json.JsonSerializer.SerializeToNode(r.Value.Ref, ContractJson.Options);
            }
            p["preparedAssetRefs"] = refs;
        }
        return await router.SendAsync(request with { Params = p }, ct);
    }

    public ValueTask DisposeAsync() => server.DisposeAsync();
}

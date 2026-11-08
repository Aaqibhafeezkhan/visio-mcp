using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Ipc;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Diagram.Mcp;

/// <summary>
/// The MCP tool surface. This process is a proxy: it forwards each call to the application over the pipe and owns no document state.
/// It never generates a transaction id and never re-sends a request; a lost reply is reported as an unknown outcome, and the caller
/// retries with the same transaction id, which the application answers from its result cache.
/// </summary>
[McpServerToolType]
public sealed class DiagramTools(PipeClient app)
{
    [McpServerTool(Name = "get_operation_schema"), Description("Discover the canonical operation contracts before calling apply_operations. Omit operation for an index; supply an exact operation name for its self-contained JSON Schema, referenced definitions, example, units, limits and targeting guidance. Works without an open document or running editor.")]
    public CallToolResult GetOperationSchema(
        [Description("Exact operation name, such as createShape, resize or set. Omit to list all operations.")] string? operation = null)
    {
        var result = OperationCatalog.Describe(operation);
        return result is null
            ? ToolErrors.Fail("invalid_request", "Unknown operation. Call get_operation_schema without operation to list supported names (case-sensitive).")
            : ToolErrors.Ok(result);
    }

    const string Identity = "Pass the documentId and sessionId returned by get_document_summary, list_documents or create_document. A different session means the document was reopened or moved to the editor window: read the summary again.";

    [McpServerTool(Name = "search_icons"), Description("Search the bundled, versioned vector icon catalogue by name or tags, such as branch, repository, docker, cloud or security. Returns stable IDs, catalogue version and a PNG preview sheet. Read-only: no shapes are placed. Call get_icon for an editable placement proposal. " + Identity)]
    public async Task<CallToolResult> SearchIcons(string documentId, string sessionId,
        [Description("Name/tag words; empty lists the catalogue.")] string query = "",
        [Description("Maximum results from 1 to 50; default 24. total/hasMore report truncation.")] int limit = 24,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return FinishImage(await Send("icons.search", documentId, sessionId, Obj(("query", query), ("limit", limit)), Render, ct));
    }

    [McpServerTool(Name = "get_icon"), Description("Preview a catalogue icon and propose editable vector-shape operations. Returns stable icon/version/hash metadata, PNG preview, and operations to apply separately with apply_operations at baseRevision. Size and stroke width are in points; x/y locate the top-left. The preview does not mutate the document. " + Identity)]
    public async Task<CallToolResult> GetIcon(string documentId, string sessionId, string pageId,
        [Description("Stable ID returned by search_icons, e.g. lucide:git-branch.")] string iconId,
        [Description("Top-left x in points.")] double x = 0,
        [Description("Top-left y in points.")] double y = 0,
        [Description("Square size, 1–1000 points. Default 24.")] double sizePt = 24,
        [Description("Stroke colour as #RRGGBB.")] string colour = "#334155",
        [Description("Stroke in points; omitted uses sizePt/12.")] double? strokeWidthPt = null,
        [Description("Optional catalogue version from search_icons, to reject a changed catalogue.")] string? catalogVersion = null,
        [Description("Optional object UUID; omitted returns a new UUID in the proposal.")] string? elementId = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("pageId", pageId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(sizePt) || strokeWidthPt is { } sw && !double.IsFinite(sw)) return ToolErrors.Fail("invalid_request", "icon dimensions must be finite");
        return FinishImage(await Send("icons.get", documentId, sessionId, Obj(("pageId", pageId), ("iconId", iconId), ("x", x), ("y", y), ("sizePt", sizePt),
            ("colour", colour), ("strokeWidthPt", strokeWidthPt), ("catalogVersion", catalogVersion), ("elementId", elementId)), Render, ct));
    }

    [McpServerTool(Name = "list_layout_components"), Description("Discover the five reusable editable diagram components: repository-card, labelled-container, environment-columns, pipeline and swimlane (lanes and phase columns with a title bar; the document summary then reports which lane and phase each shape is in). Returns versioned content/layout schemas, examples, limits and guidance. Read-only. " + Identity)]
    public async Task<CallToolResult> ListLayoutComponents(string documentId, string sessionId, CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("components.list", documentId, sessionId, new JsonObject(), Read, ct));
    }

    [McpServerTool(Name = "get_layout_component"), Description("Preview a reusable component and obtain ordinary editable group/shape/text operations. Creation uses templateId and optional content; omit content for the example. Reflow uses componentId only and reads current text/styles without changing font sizes or identities. layout controls widthPt, paddingPt, gapPt, align and target (editor/visio). Call list_layout_components for exact schemas/examples. Apply returned operations separately at baseRevision. Read-only; damaged, locked or rotated structures are refused. " + Identity)]
    public async Task<CallToolResult> GetLayoutComponent(string documentId, string sessionId, string pageId,
        [Description("Template ID for creation; omit for reflow.")] string? templateId = null,
        [Description("Content object matching the template schema from list_layout_components. Creation only.")] JsonObject? content = null,
        [Description("Layout options: widthPt 120–2000, paddingPt/gapPt 0–100, align left/center/right, target editor/visio. Default target visio is conservative, not a native guarantee.")] JsonObject? layout = null,
        [Description("Existing component group UUID for explicit reflow; omit templateId/content.")] string? componentId = null,
        [Description("Top-left x in points; omitted preserves the reflow position or uses 0 for creation.")] double? x = null,
        [Description("Top-left y in points; omitted preserves the reflow position or uses 0 for creation.")] double? y = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("pageId", pageId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (componentId is not null && Check(("componentId", componentId)) is { } badId) return ToolErrors.Fail("invalid_request", badId);
        if (x is { } px && !double.IsFinite(px) || y is { } py && !double.IsFinite(py)) return ToolErrors.Fail("invalid_request", "Component positions must be finite");
        return FinishImage(await Send("components.get", documentId, sessionId, Obj(("pageId", pageId), ("templateId", templateId), ("content", content), ("layout", layout), ("componentId", componentId), ("x", x), ("y", y)), Render, ct));
    }

    // Deadlines: reads 10 s, mutations 15 s, renders 30 s, export 120 s; the shim adds 5 s of transport time.
    static readonly TimeSpan Read = TimeSpan.FromSeconds(15), Mutate = TimeSpan.FromSeconds(20), Render = TimeSpan.FromSeconds(35), Export = TimeSpan.FromSeconds(125);

    async Task<ResponseEnvelope> Send(string method, string? documentId, string? sessionId, JsonObject p, TimeSpan deadline, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(deadline);
        var request = new RequestEnvelope { RequestId = Guid.NewGuid().ToString(), Method = method, DocumentId = documentId, SessionId = sessionId, Params = p };
        try { return await app.CallAsync(request, cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Wire.Error(request.RequestId, "timeout_unknown", "no reply before the deadline", outcome: "unknown");
        }
    }

    static CallToolResult Finish(ResponseEnvelope r) =>
        r.Error is { } e ? ToolErrors.Fail(e) : ToolErrors.Ok(JsonNode.Parse(r.Result!.Value.GetRawText())!);

    /// <summary>
    /// A rendered picture goes back as a real MCP image block plus a JSON description of it (what it shows, at which revision, how big).
    /// The base64 is never repeated inside the text.
    /// </summary>
    static CallToolResult FinishImage(ResponseEnvelope r)
    {
        if (r.Error is { } e) return ToolErrors.Fail(e);
        var body = JsonNode.Parse(r.Result!.Value.GetRawText())!.AsObject();
        var b64 = body["base64"]?.GetValue<string>();
        var mime = body["mimeType"]?.GetValue<string>();
        if (b64 is null || mime is null) return ToolErrors.Fail("internal_error", "the application returned a render without image data");
        body.Remove("base64");
        return new CallToolResult
        {
            Content = [ImageContentBlock.FromBytes(Convert.FromBase64String(b64), mime), new TextContentBlock { Text = body.ToJsonString() }],
            StructuredContent = JsonSerializer.SerializeToElement(body),
        };
    }

    static string? Check(params (string Name, string? Value)[] ids)
    {
        foreach (var (name, value) in ids) if (!Guid.TryParse(value, out _)) return $"{name} must be a UUID";
        return null;
    }

    static JsonObject Obj(params (string, JsonNode?)[] pairs)
    {
        var o = new JsonObject();
        foreach (var (k, v) in pairs) if (v is not null) o[k] = v;
        return o;
    }

    /// <summary>A short description of an object for a tool result: enough to recognise it without rereading the whole document.</summary>
    static JsonNode Brief(JsonNode full)
    {
        var o = new JsonObject();
        foreach (var key in new[] { "id", "kind", "alias", "name", "bounds" }) if (full[key] is { } v) o[key] = v.DeepClone();
        var text = full["text"]?["value"] ?? full["label"]?["value"];
        if (text is not null) o["text"] = text.DeepClone();
        return o;
    }

    async Task<JsonNode> Briefs(string documentId, string sessionId, IEnumerable<string> ids, CancellationToken ct)
    {
        var list = ids.Distinct().Take(50).ToList();
        if (list.Count == 0) return new JsonArray();
        var r = await Send("doc.getObjects", documentId, sessionId, Obj(("ids", new JsonArray(list.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray()))), Read, ct);
        if (r.Error is not null) return new JsonArray();
        var objects = JsonNode.Parse(r.Result!.Value.GetRawText())!["objects"]!.AsArray();
        return new JsonArray(objects.Select(o => Brief(o!)).ToArray());
    }

    [McpServerTool(Name = "get_document_summary"), Description("Compact semantic context for the open document: ids, revision, pages, layers and every element with its alias or name, type, bounds, text, connections and effective stacking level (missing level is 0). Call this first; it also returns the documentId and sessionId the other tools need.")]
    public async Task<CallToolResult> GetDocumentSummary(
        [Description("Limit the summary to one page.")] string? pageId = null,
        [Description("Include element bounds (default true).")] bool includeGeometry = true,
        [Description("Include fill, line and other style (default false).")] bool includeStyle = false,
        [Description("Include hidden elements (default false).")] bool includeHidden = false,
        CancellationToken ct = default)
    {
        if (pageId is not null && Check(("pageId", pageId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("doc.summary", null, null, Obj(("pageId", pageId), ("includeGeometry", includeGeometry), ("includeStyle", includeStyle), ("includeHidden", includeHidden)), Read, ct));
    }

    [McpServerTool(Name = "list_documents"), Description("Lists every open document: documentId, sessionId, title, revision, page count, whether it has unsaved changes, its saved file if any, and where it lives (view \"editor\" is a tab the person works in; \"background\" was made by an agent and is not shown yet). Read-only. Use it before addressing a document when more than one may be open.")]
    public async Task<CallToolResult> ListDocuments(CancellationToken ct = default) =>
        Finish(await Send("docs.list", null, null, new JsonObject(), Read, ct));

    [McpServerTool(Name = "create_document"), Description("Creates a new empty document in the background and returns its documentId and sessionId. It does not appear in front of the person or interrupt what they are doing; they see a tab marked as made in the background. Edit it with the other tools using the returned identity, and call show_document when the person should see it. The page is A4 landscape unless widthPt and heightPt are given.")]
    public async Task<CallToolResult> CreateDocument(
        [Description("Document title, 1 to 200 characters.")] string? title = null,
        [Description("Page width in points, 36 to 14400. Give both widthPt and heightPt or neither.")] double? widthPt = null,
        [Description("Page height in points, 36 to 14400.")] double? heightPt = null,
        CancellationToken ct = default)
    {
        if (title is { Length: 0 or > 200 }) return ToolErrors.Fail("invalid_request", "title must be 1 to 200 characters");
        if ((widthPt is null) != (heightPt is null)) return ToolErrors.Fail("invalid_request", "give both widthPt and heightPt, or neither");
        if (widthPt is { } w && !(w >= 36 && w <= 14400) || heightPt is { } h && !(h >= 36 && h <= 14400)) return ToolErrors.Fail("invalid_request", "widthPt and heightPt must be from 36 to 14400");
        return Finish(await Send("docs.create", null, null, Obj(("title", title), ("widthPt", widthPt), ("heightPt", heightPt)), Render, ct));
    }

    [McpServerTool(Name = "import_visio"), Description("Opens a Visio drawing (.vsdx) as a new background document so it can be inspected or edited as a reference. Read the shapes with get_document_summary and get_objects (absolute page coordinates in points, groups, layers, text, geometry, connections), look at it with render_page, and call show_document to show the person. The file is only read, never changed, and no document that is already open is touched. The result lists what the importer could not represent (diagnostics, lossy) and what happened to element identity. The file must be in the open document's folder or the application's export folder, otherwise the person is asked to approve it; files over 64 MB or with more than 200 pages or 20,000 shapes are refused.")]
    public async Task<CallToolResult> ImportVisio(
        [Description("Absolute path of a .vsdx file, or a file name inside the application's export folder.")] string path,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1024) return ToolErrors.Fail("invalid_request", "path must be 1 to 1024 characters");
        return Finish(await Send("docs.importVisio", null, null, Obj(("path", path)), Export, ct));
    }

    [McpServerTool(Name = "show_document"), Description("Puts an open document in front of the person: a document in an editor tab is switched to; one made in the background is moved into the editor window as a new tab and gets a new sessionId (read it from the result). Refused with busy_user_editing while the person is in the middle of dragging or typing: wait a moment and try again. Nothing is saved or exported by this.")]
    public async Task<CallToolResult> ShowDocument(
        [Description("The documentId from list_documents or create_document.")] string documentId,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("docs.show", null, null, Obj(("documentId", documentId)), Render, ct));
    }

    [McpServerTool(Name = "get_objects"), Description("Complete canonical objects for the given ids (UUIDs, or aliases when the document has one page), including optional stacking level (missing means 0). The response also includes routeDiagnostics for requested connectors when projection is ready; provenance and findings are derived from the same returned revision and do not mutate the document. If projection is unavailable, canonical objects remain available and routeDiagnosticsStatus explains why diagnostics are unavailable. " + Identity)]
    public async Task<CallToolResult> GetObjects(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("Element ids to fetch, at most 500.")] string[] ids,
        [Description("Page that aliases and names are looked up on.")] string? pageId = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("doc.getObjects", documentId, sessionId, Obj(("ids", new JsonArray(ids.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray())), ("pageId", pageId)), Read, ct));
    }

    [McpServerTool(Name = "apply_operations"), Description("Applies a batch of typed operations as one atomic transaction at baseRevision. Call get_operation_schema first for operation schemas and examples, including text/style fields, units and targeting rules. Beautify accepts exact previewed route points for eligible Automatic connectors without converting them to Manual; the engine validates all proposed routes, sets its own beautified marker, and requires Beautify to be the only operation in that transaction. If the document changed since baseRevision the call fails with revision_conflict and changes nothing. You supply the transactionId: retrying with the same id and payload returns the original result instead of applying twice. " + Identity)]
    public async Task<CallToolResult> ApplyOperations(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("A UUID you choose for this transaction. Reuse it only to retry the identical request.")] string transactionId,
        [Description("The revision this batch was planned against.")] int baseRevision,
        [Description("The operations, in order. Each has an op field such as createShape, set, move, resize, rotate, delete, group, align, reorder.")] JsonElement operations,
        [Description("Must be true: batches are all or nothing.")] bool atomic = true,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("transactionId", transactionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (!atomic) return ToolErrors.Fail("invalid_request", "only atomic batches are supported");
        if (operations.ValueKind != JsonValueKind.Array) return ToolErrors.Fail("invalid_request", "operations must be an array");
        var r = await Send("doc.apply", documentId, sessionId,
            Obj(("transactionId", transactionId), ("baseRevision", baseRevision), ("atomic", true), ("operations", JsonNode.Parse(operations.GetRawText()))), Mutate, ct);
        if (r.Error is not null) return ToolErrors.Fail(r.Error);
        var transaction = JsonNode.Parse(r.Result!.Value.GetRawText())!;
        var ids = (transaction["created"]?.AsArray() ?? []).Concat(transaction["changed"]?.AsArray() ?? []).Select(n => n!.GetValue<string>());
        return ToolErrors.Ok(new JsonObject { ["transaction"] = transaction, ["objects"] = await Briefs(documentId, sessionId, ids, ct) });
    }

    [McpServerTool(Name = "execute_script"), Description("Compiles DrawScript and runs it as one atomic transaction at baseRevision. The result includes the operations the script became. Same retry rule as apply_operations. " + Identity)]
    public async Task<CallToolResult> ExecuteScript(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("A UUID you choose for this transaction. Reuse it only to retry the identical request.")] string transactionId,
        [Description("The revision this script was written against.")] int baseRevision,
        [Description("DrawScript source, one command per line.")] string script,
        [Description("Page used for names and aliases when the script does not say 'page use'.")] string? pageId = null,
        [Description("Must be true.")] bool atomic = true,
        [Description("Library pictures the script may import, by id (\"asset:logo\") or id and version hash (\"asset:logo@<sha256>\"). In the script write: asset import prepared=\"asset:logo\" and then use that id. If the document already holds different bytes under that id, a separate version asset:<name>~<sha256> is registered and the script means that version. See list_assets.")] string[]? libraryAssets = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("transactionId", transactionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (!atomic) return ToolErrors.Fail("invalid_request", "only atomic scripts are supported");
        var r = await Send("doc.executeScript", documentId, sessionId,
            Obj(("transactionId", transactionId), ("baseRevision", baseRevision), ("atomic", true), ("script", script), ("pageId", pageId),
                ("libraryAssets", libraryAssets is null ? null : new JsonArray(libraryAssets.Select(a => (JsonNode)JsonValue.Create(a)!).ToArray()))), Mutate, ct);
        if (r.Error is not null) return ToolErrors.Fail(r.Error);
        var body = JsonNode.Parse(r.Result!.Value.GetRawText())!.AsObject();
        var t = body["transaction"]!;
        var ids = (t["created"]?.AsArray() ?? []).Concat(t["changed"]?.AsArray() ?? []).Select(n => n!.GetValue<string>());
        body["objects"] = await Briefs(documentId, sessionId, ids, ct);
        return ToolErrors.Ok(body);
    }

    [McpServerTool(Name = "render_page"), Description("Renders a page to a PNG or JPEG image (an image block plus JSON metadata with the revision it shows). debug mode overlays element ids and bounds. " + Identity)]
    public async Task<CallToolResult> RenderPage(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("The page to render.")] string pageId,
        [Description("png or jpeg.")] string format = "png",
        [Description("Maximum width in pixels (default 1600).")] int maxWidth = 1600,
        [Description("Maximum height in pixels (default 1200).")] int maxHeight = 1200,
        [Description("clean or debug (debug overlays ids and bounds).")] string mode = "clean",
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("pageId", pageId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return FinishImage(await Send("doc.render", documentId, sessionId, Obj(("scope", "page"), ("pageId", pageId), ("format", format), ("maxWidth", maxWidth), ("maxHeight", maxHeight), ("mode", mode)), Render, ct));
    }

    [McpServerTool(Name = "render_region"), Description("Renders part of a page, given as bounds or element ids, with padding: a cheap way to check one correction. " + Identity)]
    public async Task<CallToolResult> RenderRegion(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("The page to render.")] string pageId,
        [Description("Region as {x,y,width,height} in points. Give this or elementIds, not both.")] JsonElement? bounds = null,
        [Description("Element ids to frame. Give this or bounds, not both.")] string[]? elementIds = null,
        [Description("Padding in points around the region.")] double paddingPt = 12,
        [Description("png or jpeg.")] string format = "png",
        [Description("clean or debug.")] string mode = "clean",
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("pageId", pageId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return FinishImage(await Send("doc.render", documentId, sessionId, Obj(("scope", "region"), ("pageId", pageId), ("bounds", bounds is { } b ? JsonNode.Parse(b.GetRawText()) : null),
            ("elementIds", elementIds is null ? null : new JsonArray(elementIds.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray())), ("paddingPt", paddingPt), ("format", format), ("mode", mode)), Render, ct));
    }

    [McpServerTool(Name = "render_reference_region"), Description("Read-only magnified crop of an approved PNG/JPEG/BMP image asset. Call list_assets for its ID, scope and SHA-256 hash; import references through the app's asset library first. cropPx is in original image pixels, not document points. Returns a PNG image block, source dimensions, pinned hash and source-to-output coordinate mapping. No file paths or document changes. " + Identity)]
    public async Task<CallToolResult> RenderReferenceRegion(
        string documentId, string sessionId,
        [Description("Approved image ID from list_assets.")] string referenceAssetId,
        [Description("Exact lowercase SHA-256 version from list_assets; prevents silent source changes.")] string referenceSha256,
        [Description("{x,y,width,height} in integer source pixels; must be fully inside the original image.")] JsonElement cropPx,
        [Description("library or document; matches the approved source's scope.")] string referenceScope = "library",
        [Description("Magnification 1–16, default 8; output is limited to 4096 pixels per side and 16 megapixels.")] double scale = 8,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (!double.IsFinite(scale)) return ToolErrors.Fail("invalid_request", "scale must be finite");
        return FinishImage(await Send("reference.render", documentId, sessionId,
            Obj(("referenceAssetId", referenceAssetId), ("referenceSha256", referenceSha256), ("referenceScope", referenceScope),
                ("cropPx", JsonNode.Parse(cropPx.GetRawText())), ("scale", scale)), Render, ct));
    }

    [McpServerTool(Name = "compare_reference"), Description("Read-only comparison of an approved reference-image crop with a committed canvas region. Returns an enlarged side-by-side PNG or a 50% canvas overlay, pinned source hash, document revision and coordinate mappings. Each crop is fitted without stretching and centred in equally sized panels; this is visual inspection, not an automatic accuracy score. Use side_by_side when source and canvas themes differ. Call list_assets to obtain approved reference IDs and hashes. " + Identity)]
    public async Task<CallToolResult> CompareReference(
        string documentId, string sessionId, string pageId,
        [Description("Approved PNG/JPEG/BMP image ID from list_assets.")] string referenceAssetId,
        [Description("Exact lowercase SHA-256 source version from list_assets.")] string referenceSha256,
        [Description("{x,y,width,height} in integer source image pixels.")] JsonElement cropPx,
        [Description("Canvas region {x,y,width,height} in document points. Give this or elementIds, not both.")] JsonElement? bounds = null,
        [Description("Canvas element UUIDs, or page-scoped aliases/names. Give this or bounds, not both.")] string[]? elementIds = null,
        [Description("library or document, matching list_assets.")] string referenceScope = "library",
        [Description("side_by_side (default) or overlay (reference then canvas at 50% opacity).")] string mode = "side_by_side",
        [Description("Square panel size in output pixels, 64–2048; default 512.")] int panelSizePx = 512,
        [Description("Extra canvas margin in document points, 0–2000. Default 6 protects icon strokes at the crop edges; source crop is unchanged.")] double paddingPt = 6,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId), ("pageId", pageId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (!double.IsFinite(paddingPt)) return ToolErrors.Fail("invalid_request", "paddingPt must be finite");
        return FinishImage(await Send("reference.compare", documentId, sessionId,
            Obj(("referenceAssetId", referenceAssetId), ("referenceSha256", referenceSha256), ("referenceScope", referenceScope),
                ("cropPx", JsonNode.Parse(cropPx.GetRawText())), ("pageId", pageId), ("bounds", bounds is { } b ? JsonNode.Parse(b.GetRawText()) : null),
                ("elementIds", elementIds is null ? null : JsonSerializer.SerializeToNode(elementIds)), ("mode", mode), ("panelSizePx", panelSizePx), ("paddingPt", paddingPt)), Render, ct));
    }

    [McpServerTool(Name = "get_text_layout"), Description("Read-only text measurements and fitting proposals for existing text objects or shapes with text. Returns the committed revision, line counts, required dimensions, overflow, and suggested resize or font-size operations; apply those separately with apply_operations at the returned revision. Uses editor font advances and estimated line heights. Visio mode adds conservative margins, not a guarantee of native wrapping. " + Identity)]
    public async Task<CallToolResult> GetTextLayout(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("1 to 50 text-object or text-bearing-shape UUIDs; aliases/names need page scope. Prefer UUIDs.")] string[] ids,
        [Description("grow_box (preserve font and grow dimensions) or shrink_font (preserve bounds; never grow font).")] string strategy = "grow_box",
        [Description("editor, or visio for a one-em minimum advance per symbol, 10% extra advance/line height and 2pt extra inset per side. Verify Visio export independently.")] string target = "editor",
        [Description("Minimum allowed font size for shrink_font, in points. Default 8; greater than 0 and at most 1000.")] double minFontSizePt = 8,
        [Description("Page UUID for alias/name lookup; omitted only when the document has one page or ids are UUIDs.")] string? pageId = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (pageId is not null && Check(("pageId", pageId)) is { } badPage) return ToolErrors.Fail("invalid_request", badPage);
        if (ids.Length is < 1 or > 50 || ids.Any(i => string.IsNullOrEmpty(i) || i.Length > 256)) return ToolErrors.Fail("invalid_request", "ids must contain 1 to 50 nonempty UUIDs, aliases or names");
        if (strategy is not ("grow_box" or "shrink_font") || target is not ("editor" or "visio")) return ToolErrors.Fail("invalid_request", "strategy must be grow_box or shrink_font; target must be editor or visio");
        if (!double.IsFinite(minFontSizePt) || minFontSizePt <= 0 || minFontSizePt > 1000) return ToolErrors.Fail("invalid_request", "minFontSizePt must be greater than 0 and at most 1000");
        return Finish(await Send("doc.textLayout", documentId, sessionId,
            Obj(("ids", new JsonArray(ids.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray())), ("strategy", strategy), ("target", target), ("minFontSizePt", minFontSizePt), ("pageId", pageId)), Read, ct));
    }

    [McpServerTool(Name = "inspect_layout"), Description("Machine-readable layout warnings (outside the page, overlaps, clipped text, unattached connectors, connectors through shapes, stretched pictures, low contrast). Routing findings (R26) carry evidence.classification and evidence.intended, so a defect can be told from something drawn on purpose: through shapes CONNECTOR_CROSSES_SHAPE (warning, with the obstacle policy of each shape), CONNECTOR_CROSSES_CONTAINER (info, a frame round one of its ends), CONNECTOR_CROSSES_BACKGROUND (info, a page-size backdrop), CONNECTOR_PASSES_OVER_SHAPE (info, a shape on a lower level); between connectors CONNECTORS_CROSS (info; classification hopped when a line hop draws it), CONNECTOR_JOIN (info, a T-junction), CONNECTOR_TOUCHES_CONNECTOR (warning, an end on another connector without a join), CONNECTORS_OVERLAP (warning, drawn on top of each other), CONNECTORS_TOO_CLOSE (info, parallel runs under 4 pt apart); route shape, for automatic and guided routes only (manual and frozen routes are deliberate) ROUTE_SHORT_SEGMENT, ROUTE_REDUNDANT_VERTEX, ROUTE_EXCESS_BENDS, ROUTE_TOO_CLOSE_TO_SHAPE, each with evidence.suggestion (straighten, remove_vertices, reroute, move_run); and UNRESOLVED_ROUTE, ROUTING_AVOIDANCE_VIOLATION, ROUTE_SIDE_PREFERENCE_RELAXED, ROUTE_REQUIRED_SIDE_UNRESOLVED (error when a hard endpoint side has no route), UNGLUED_CONNECTOR_END, DANGLING_CONNECTOR. Connector-to-connector and route-shape checks need drawn routes and are skipped when none are available. Each issue has element ids, page and bounds. For text measurements and fitting proposals, call get_text_layout. " + Identity)]
    public async Task<CallToolResult> InspectLayout(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("Limit to one page.")] string? pageId = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("doc.inspectLayout", documentId, sessionId, Obj(("pageId", pageId)), Read, ct));
    }

    [McpServerTool(Name = "propose_routes"), Description("Read-only preview of rerouting automatic orthogonal connectors from scratch, before changing anything. Name connectorIds (UUIDs on one page) or give pageId alone for every eligible connector on that page (manual, frozen, non-orthogonal and locked connectors are listed in skipped). Returns the revision it read, each route's points in page points, provenance, reason, geometryChanged (whether the drawing would change), lengthPt and bends, plus routeFindings (UNRESOLVED_ROUTE and others) and visuallyAffectedIds (attached labels move too). commit is present only when the drawing would change, no route is unresolved and nothing outside the targets would change: pass commit.operations unchanged to apply_operations at commit.baseRevision with a new transactionId; a stale commit fails with revision_conflict. dependency_conflict names other connectors the reroute would change (include them) or joined connectors it cannot keep joined (reason join_not_followed). projection_failed means routes the answer depends on could not be read. " + Identity)]
    public async Task<CallToolResult> ProposeRoutes(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("Connector UUIDs to reroute, 1 to 1000, all on one page. Omit to consider every connector on the page.")] string[]? connectorIds = null,
        [Description("The page. Needed when connectorIds is omitted on a document with more than one page.")] string? pageId = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (pageId is not null && Check(("pageId", pageId)) is { } badPage) return ToolErrors.Fail("invalid_request", badPage);
        return Finish(await Send("doc.proposeRoutes", documentId, sessionId,
            Obj(("connectorIds", connectorIds is null ? null : new JsonArray(connectorIds.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray())), ("pageId", pageId)), Read, ct));
    }

    [McpServerTool(Name = "list_assets"), Description("Image assets: those pinned in the document (scope \"document\": ids, names, types, tags, how many images use each) and those in the user's approved library (scope \"library\"). A document entry wins an exact id match and says newerInLibrary when the library has changed. To place a library picture pass its id in execute_script libraryAssets. " + Identity)]
    public async Task<CallToolResult> ListAssets(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("Text to look for in asset ids and names.")] string? query = null,
        [Description("Only assets with any of these tags.")] string[]? tags = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("assets.list", documentId, sessionId, Obj(("query", query), ("tags", tags is null ? null : new JsonArray(tags.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()))), Read, ct));
    }

    [McpServerTool(Name = "get_changes"), Description("Transaction summaries since a revision (created, changed and deleted ids), so you can recover from human edits without rereading the document. " + Identity)]
    public async Task<CallToolResult> GetChanges(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("Return transactions after this revision.")] int sinceRevision,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        return Finish(await Send("doc.changes", documentId, sessionId, Obj(("sinceRevision", sinceRevision)), Read, ct));
    }

    [McpServerTool(Name = "export_document"), Description("Exports the document as vsdx (editable Visio), svg, png or jpeg. The file is written inside the open document's folder or the application's export folder; the result gives its path, and for vsdx lists anything Visio could not hold. " + Identity)]
    public async Task<CallToolResult> ExportDocument(
        [Description("The document id from get_document_summary.")] string documentId,
        [Description("The session id from get_document_summary.")] string sessionId,
        [Description("vsdx, svg, png or jpeg.")] string format,
        [Description("Optional file name or path inside the approved folders. Omitted: a name is made from the title and revision.")] string? path = null,
        [Description("For svg, png and jpeg: the page to export (default: the only or first page).")] string? pageId = null,
        CancellationToken ct = default)
    {
        if (Check(("documentId", documentId), ("sessionId", sessionId)) is { } bad) return ToolErrors.Fail("invalid_request", bad);
        if (pageId is not null && Check(("pageId", pageId)) is { } badPage) return ToolErrors.Fail("invalid_request", badPage);
        return Finish(await Send("doc.export", documentId, sessionId, Obj(("format", format), ("path", path), ("pageId", pageId)), Export, ct));
    }
}

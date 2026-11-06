using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Diagram.Ipc;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Xunit;

public class ToolTests
{
    const string Doc = "00000000-0000-4000-8000-000000000001", Session = "00000000-0000-4000-8000-000000000002", Tx = "00000000-0000-4000-8000-000000000003";
    static readonly string[] SourceTools =
    [
        "get_document_summary", "get_objects", "apply_operations", "execute_script", "render_page", "render_region",
        "inspect_layout", "list_assets", "get_changes", "export_document", "get_operation_schema", "get_text_layout",
        "render_reference_region", "compare_reference", "search_icons", "get_icon", "list_layout_components", "get_layout_component",
        "list_documents", "create_document", "show_document", "import_visio",
    ];

    static string NewPipe() => $"mcp-test-{Guid.NewGuid():N}";
    static CancellationToken Ct(int seconds = 60) => new CancellationTokenSource(TimeSpan.FromSeconds(seconds)).Token;

    static string ShimDll()
    {
        var cfg = AppContext.BaseDirectory.Contains($"{Path.DirectorySeparatorChar}Release{Path.DirectorySeparatorChar}") ? "Release" : "Debug";
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Diagram.Mcp", "bin", cfg, "net10.0"));
        return Path.Combine(root, "Diagram.Mcp.dll");
    }

    [Fact]
    public async Task TextLayoutForwardsScopeAndReadOptionsWithoutInventingATransaction()
    {
        var pipe = NewPipe(); var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle);
        await using var client = await Connect(pipe);
        var result = await client.CallToolAsync("get_text_layout", new Dictionary<string, object?>
        {
            ["documentId"] = Doc, ["sessionId"] = Session, ["ids"] = new[] { "label" },
            ["strategy"] = "shrink_font", ["target"] = "visio", ["minFontSizePt"] = 9.5,
        }, cancellationToken: Ct());
        Assert.True(result.IsError != true, result.StructuredContent?.ToString());
        var sent = app.Last("doc.textLayout");
        Assert.Equal(Doc, sent.DocumentId); Assert.Equal(Session, sent.SessionId);
        Assert.Equal("label", sent.Params["ids"]![0]!.GetValue<string>());
        Assert.Equal("shrink_font", sent.Params["strategy"]!.GetValue<string>());
        Assert.Equal("visio", sent.Params["target"]!.GetValue<string>());
        Assert.Equal(9.5, sent.Params["minFontSizePt"]!.GetValue<double>());
        Assert.False(sent.Params.ContainsKey("transactionId"));
        var invalid = await client.CallToolAsync("get_text_layout", new Dictionary<string, object?>
        { ["documentId"] = Doc, ["sessionId"] = Session, ["ids"] = Array.Empty<string>() }, cancellationToken: Ct());
        Assert.True(invalid.IsError);
        Assert.Equal(1, app.Count("doc.textLayout"));
    }

    [Fact]
    public async Task DocumentToolsForwardToTheApplicationAndCheckTheirArguments()
    {
        var pipe = NewPipe();
        var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle);
        await using var client = await Connect(pipe);

        var listed = await client.CallToolAsync("list_documents", new Dictionary<string, object?>(), cancellationToken: Ct());
        Assert.True(listed.IsError != true);
        Assert.Equal(1, app.Count("docs.list"));

        var created = await client.CallToolAsync("create_document", new Dictionary<string, object?> { ["title"] = "Pipeline", ["widthPt"] = 600.0, ["heightPt"] = 400.0 }, cancellationToken: Ct());
        Assert.True(created.IsError != true);
        var sent = app.Last("docs.create");
        Assert.Null(sent.DocumentId);
        Assert.Equal("Pipeline", sent.Params["title"]!.GetValue<string>());
        Assert.Equal(600.0, sent.Params["widthPt"]!.GetValue<double>());

        Assert.True((await client.CallToolAsync("create_document", new Dictionary<string, object?> { ["title"] = "" }, cancellationToken: Ct())).IsError);
        Assert.True((await client.CallToolAsync("create_document", new Dictionary<string, object?> { ["widthPt"] = 600.0 }, cancellationToken: Ct())).IsError); // both or neither
        Assert.True((await client.CallToolAsync("create_document", new Dictionary<string, object?> { ["widthPt"] = 10.0, ["heightPt"] = 400.0 }, cancellationToken: Ct())).IsError);
        Assert.Equal(1, app.Count("docs.create")); // refused before it reached the application

        var shown = await client.CallToolAsync("show_document", new Dictionary<string, object?> { ["documentId"] = Doc }, cancellationToken: Ct());
        Assert.True(shown.IsError != true);
        Assert.Equal(Doc, app.Last("docs.show").Params["documentId"]!.GetValue<string>());
        Assert.True((await client.CallToolAsync("show_document", new Dictionary<string, object?> { ["documentId"] = "not-a-uuid" }, cancellationToken: Ct())).IsError);
        Assert.Equal(1, app.Count("docs.show"));
    }

    static Task<McpClient> Connect(string pipe) => McpClient.CreateAsync(new StdioClientTransport(new StdioClientTransportOptions
    {
        Name = "test", Command = "dotnet", Arguments = [ShimDll()],
        EnvironmentVariables = new Dictionary<string, string?> { ["DIAGRAM_PIPE"] = pipe },
    }), cancellationToken: Ct());

    /// <summary>A stand-in application that records what the shim sent and answers like the page would.</summary>
    sealed class FakeApp
    {
        public readonly List<RequestEnvelope> Seen = new();
        public Func<RequestEnvelope, Task<ResponseEnvelope>>? Override;
        public Task<ResponseEnvelope> Handle(ConnectionInfo c, RequestEnvelope r, CancellationToken ct)
        {
            lock (Seen) Seen.Add(r);
            if (Override is not null) return Override(r);
            return Task.FromResult(r.Method switch
            {
                "doc.summary" => Wire.Ok(r.RequestId, new JsonObject { ["documentId"] = Doc, ["sessionId"] = Session, ["revision"] = 3, ["pages"] = new JsonArray() }),
                "doc.apply" => Wire.Ok(r.RequestId, new JsonObject
                {
                    ["transactionId"] = r.Params["transactionId"]!.DeepClone(), ["previousRevision"] = r.Params["baseRevision"]!.DeepClone(), ["revision"] = 4,
                    ["created"] = new JsonArray("00000000-0000-4000-8000-0000000000aa"), ["changed"] = new JsonArray(), ["deleted"] = new JsonArray(),
                }),
                "doc.getObjects" => Wire.Ok(r.RequestId, new JsonObject
                {
                    ["revision"] = 4,
                    ["objects"] = new JsonArray(new JsonObject { ["id"] = "00000000-0000-4000-8000-0000000000aa", ["kind"] = "shape", ["alias"] = "box", ["bounds"] = new JsonObject { ["x"] = 1 }, ["style"] = new JsonObject { ["big"] = "x" }, ["text"] = new JsonObject { ["value"] = "Hello" } }),
                }),
                "doc.render" or "doc.inspectLayout" or "doc.export" => Wire.Error(r.RequestId, "not_ready", "later"),
                _ => Wire.Ok(r.RequestId, new JsonObject { ["method"] = r.Method }),
            });
        }
        public RequestEnvelope Last(string method) { lock (Seen) return Seen.Last(r => r.Method == method); }
        public int Count(string method) { lock (Seen) return Seen.Count(r => r.Method == method); }
    }

    static JsonElement Structured(CallToolResult r) => r.StructuredContent!.Value;

    [Fact]
    public async Task AllToolNamesMatchSource()
    {
        await using var client = await Connect(NewPipe());
        var tools = await client.ListToolsAsync(cancellationToken: Ct());
        Assert.Equal(SourceTools.OrderBy(x => x), tools.Select(t => t.Name).OrderBy(x => x));
        // nothing that opens, saves, replaces or runs anything outside the document
        Assert.DoesNotContain(tools, t => t.Name.Contains("open") || t.Name.Contains("save") || t.Name.Contains("shell") || t.Name.Contains("replace"));
        Assert.DoesNotContain(tools, t => t.Name.Contains("preferences", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ToolSchemasRequireIdentity()
    {
        await using var client = await Connect(NewPipe());
        var tools = (await client.ListToolsAsync(cancellationToken: Ct())).ToDictionary(t => t.Name);
        static string[] Required(McpClientTool t) => t.JsonSchema.TryGetProperty("required", out var r) ? r.EnumerateArray().Select(x => x.GetString()!).ToArray() : [];

        Assert.Empty(Required(tools["get_document_summary"])); // the first call: it hands out the identity
        Assert.Empty(Required(tools["get_operation_schema"]));
        Assert.Empty(Required(tools["list_documents"]));   // they hand out identities too
        Assert.Empty(Required(tools["create_document"]));
        Assert.Equal(new[] { "path" }, Required(tools["import_visio"])); // it creates the document, so it has no identity to pass
        Assert.Equal(new[] { "documentId" }, Required(tools["show_document"])); // it names a document, and the session changes when it moves
        foreach (var name in SourceTools.Where(n => n is not ("get_document_summary" or "get_operation_schema" or "list_documents" or "create_document" or "show_document" or "import_visio")))
        {
            Assert.Contains("documentId", Required(tools[name]));
            Assert.Contains("sessionId", Required(tools[name]));
        }
        foreach (var name in new[] { "apply_operations", "execute_script" })
        {
            Assert.Contains("transactionId", Required(tools[name]));
            Assert.Contains("baseRevision", Required(tools[name]));
        }
        Assert.Contains("operations", Required(tools["apply_operations"]));
        Assert.Contains("script", Required(tools["execute_script"]));
        Assert.Contains("sinceRevision", Required(tools["get_changes"]));
    }

    [Fact]
    public async Task OperationDiscoveryWorksOfflineAndMatchesCanonicalContracts()
    {
        await using var client = await Connect(NewPipe()); // No pipe server or open document.
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var canonical = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(root, "contracts", "operations.schema.json")))!;
        var document = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(root, "contracts", "document.schema.json")))!;
        var examples = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(root, "contracts", "fixtures", "operation-examples.json")))!;
        var protocol = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(root, "contracts", "protocol.schema.json")))!;
        var index = await client.CallToolAsync("get_operation_schema", cancellationToken: Ct());
        Assert.False(index.IsError == true);
        var body = Structured(index);
        Assert.Contains("points", body.GetProperty("guidance").GetProperty("coordinates").GetString());
        Assert.Contains("UUID", body.GetProperty("guidance").GetProperty("targets").GetString());
        Assert.Contains("level first", body.GetProperty("guidance").GetProperty("editing").GetString());
        Assert.Contains("Group level changes", body.GetProperty("guidance").GetProperty("editing").GetString());
        Assert.Contains("Membership changes only through contain", body.GetProperty("guidance").GetProperty("editing").GetString());
        Assert.Equal(protocol["$defs"]!["MutationRequest"]!["properties"]!["operations"]!["maxItems"]!.GetValue<int>(), body.GetProperty("limits").GetProperty("maxItems").GetInt32());
        var names = body.GetProperty("operations").EnumerateArray().Select(x => x.GetProperty("operation").GetString()!).ToArray();
        var expected = canonical["$defs"]!["Operation"]!["oneOf"]!.AsArray().Select(r =>
        {
            var def = r!["$ref"]!.GetValue<string>().Split('/').Last();
            return canonical["$defs"]![def]!["properties"]!["op"]!["const"]!.GetValue<string>();
        }).ToArray();
        Assert.Equal(expected.Order(), names.Order());
        foreach (var name in names)
        {
            var result = await client.CallToolAsync("get_operation_schema", new Dictionary<string, object?> { ["operation"] = name }, cancellationToken: Ct());
            Assert.False(result.IsError == true);
            var detail = JsonNode.Parse(Structured(result).GetRawText())!;
            var schema = detail["schema"]!;
            Assert.Equal(name, schema["properties"]!["op"]!["const"]!.GetValue<string>());
            Assert.Equal(name, detail["example"]!["op"]!.GetValue<string>());
            Assert.True(JsonNode.DeepEquals(examples[name], detail["example"]), name + " example differs from validated fixture");
            var def = canonical["$defs"]!.AsObject().First(x => x.Value?["properties"]?["op"]?["const"]?.ToString() == name).Value!;
            var actual = schema.DeepClone().AsObject(); actual.Remove("$schema"); actual.Remove("$defs");
            Assert.True(JsonNode.DeepEquals(Normalize(def), actual), name + " schema differs from canonical contract");
            CheckReferences(schema, schema);
            foreach (var entry in schema["$defs"]!.AsObject())
                Assert.True(JsonNode.DeepEquals(Normalize(canonical["$defs"]![entry.Key] ?? document["$defs"]![entry.Key]!), entry.Value), entry.Key);
        }
        var unknown = await client.CallToolAsync("get_operation_schema", new Dictionary<string, object?> { ["operation"] = "notAnOperation" }, cancellationToken: Ct());
        Assert.True(unknown.IsError);
        Assert.Equal("invalid_request", Structured(unknown).GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("get_operation_schema", Structured(unknown).GetProperty("error").GetProperty("message").GetString());

        static JsonNode Normalize(JsonNode source)
        {
            var n = source.DeepClone();
            void Walk(JsonNode? value)
            {
                if (value is JsonObject o) foreach (var p in o.ToArray())
                {
                    if (p.Key == "$ref") o[p.Key] = "#/$defs/" + p.Value!.GetValue<string>().Split('/').Last();
                    else Walk(p.Value);
                }
                else if (value is JsonArray a) foreach (var item in a) Walk(item);
            }
            Walk(n); return n;
        }
        static void CheckReferences(JsonNode? node, JsonNode root)
        {
            if (node is JsonObject o) foreach (var p in o)
            {
                if (p.Key == "$ref")
                {
                    Assert.StartsWith("#/$defs/", p.Value!.ToString());
                    Assert.NotNull(root["$defs"]![p.Value.ToString().Split('/').Last()]);
                }
                else CheckReferences(p.Value, root);
            }
            else if (node is JsonArray a) foreach (var item in a) CheckReferences(item, root);
        }
    }

    [Fact]
    public async Task MutationIdentityIsForwardedUnchangedAndNeverInvented()
    {
        var pipe = NewPipe();
        var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle);
        await using var client = await Connect(pipe);
        var ops = JsonDocument.Parse("""[{"op":"createShape","bounds":{"x":1,"y":1,"width":10,"height":10}}]""").RootElement;
        var result = await client.CallToolAsync("apply_operations", new Dictionary<string, object?>
        {
            ["documentId"] = Doc, ["sessionId"] = Session, ["transactionId"] = Tx, ["baseRevision"] = 3, ["operations"] = ops,
        }, cancellationToken: Ct());
        Assert.True(result.IsError != true);
        var sent = app.Last("doc.apply");
        Assert.Equal(Doc, sent.DocumentId);
        Assert.Equal(Session, sent.SessionId);
        Assert.Equal(Tx, sent.Params["transactionId"]!.GetValue<string>()); // the client's id, not one the shim made up
        Assert.Equal(3, sent.Params["baseRevision"]!.GetValue<int>());
        Assert.True(sent.Params["atomic"]!.GetValue<bool>());
        Assert.Equal("mcp", sent.Origin!.Source); // stamped by the application's pipe server, not by the shim

        // the result has the transaction untouched plus a short description of what it created
        var body = Structured(result);
        Assert.Equal(Tx, body.GetProperty("transaction").GetProperty("transactionId").GetString());
        var obj = body.GetProperty("objects")[0];
        Assert.Equal("box", obj.GetProperty("alias").GetString());
        Assert.Equal("Hello", obj.GetProperty("text").GetString());
        Assert.False(obj.TryGetProperty("style", out _)); // concise: no style dump
    }

    [Fact]
    public async Task BadInputIsRejectedBeforeItReachesTheApplication()
    {
        var pipe = NewPipe();
        var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle);
        await using var client = await Connect(pipe);
        var ok = JsonDocument.Parse("[]").RootElement;
        var notUuid = await client.CallToolAsync("apply_operations", new Dictionary<string, object?> { ["documentId"] = "nope", ["sessionId"] = Session, ["transactionId"] = Tx, ["baseRevision"] = 0, ["operations"] = ok }, cancellationToken: Ct());
        Assert.True(notUuid.IsError);
        Assert.Equal("invalid_request", Structured(notUuid).GetProperty("error").GetProperty("code").GetString());
        var notAtomic = await client.CallToolAsync("execute_script", new Dictionary<string, object?> { ["documentId"] = Doc, ["sessionId"] = Session, ["transactionId"] = Tx, ["baseRevision"] = 0, ["script"] = "x", ["atomic"] = false }, cancellationToken: Ct());
        Assert.Equal("invalid_request", Structured(notAtomic).GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, app.Count("doc.apply") + app.Count("doc.executeScript"));
    }

    [Fact]
    public async Task ApplicationErrorsKeepTheirCodeRetryableAndOutcome()
    {
        var pipe = NewPipe();
        var app = new FakeApp { Override = r => Task.FromResult(Wire.Error(r.RequestId, "revision_conflict", "the document is at revision 9", retryable: false, details: new JsonObject { ["actual"] = 9 })) };
        await using var server = PipeServer.Start(pipe, app.Handle);
        await using var client = await Connect(pipe);
        var r = await client.CallToolAsync("get_changes", new Dictionary<string, object?> { ["documentId"] = Doc, ["sessionId"] = Session, ["sinceRevision"] = 1 }, cancellationToken: Ct());
        Assert.True(r.IsError);
        var err = Structured(r).GetProperty("error");
        Assert.Equal("revision_conflict", err.GetProperty("code").GetString());
        Assert.False(err.GetProperty("retryable").GetBoolean());
        Assert.Equal(9, err.GetProperty("details").GetProperty("actual").GetInt32());
    }

    [Fact]
    public async Task RenderLayoutAndExportAdvertiseNotReady()
    {
        var pipe = NewPipe();
        var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle);
        await using var client = await Connect(pipe);
        var args = new Dictionary<string, object?> { ["documentId"] = Doc, ["sessionId"] = Session, ["pageId"] = Doc };
        foreach (var (tool, extra) in new (string, Dictionary<string, object?>)[]
        {
            ("render_page", new()), ("render_region", new()), ("inspect_layout", new()), ("export_document", new() { ["format"] = "png" }),
        })
        {
            var r = await client.CallToolAsync(tool, args.Concat(extra).ToDictionary(k => k.Key, k => k.Value), cancellationToken: Ct());
            Assert.True(r.IsError, tool);
            Assert.Equal("not_ready", Structured(r).GetProperty("error").GetProperty("code").GetString());
        }
    }

    [Fact]
    public async Task NotRunningThenRecovers()
    {
        var pipe = NewPipe();
        await using var client = await Connect(pipe); // no application yet
        var down = await client.CallToolAsync("get_document_summary", cancellationToken: Ct());
        Assert.True(down.IsError);
        var e = Structured(down).GetProperty("error");
        Assert.Equal("not_running", e.GetProperty("code").GetString());
        Assert.True(e.GetProperty("retryable").GetBoolean());

        var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle); // the application starts later; the shim connects lazily
        var up = await client.CallToolAsync("get_document_summary", cancellationToken: Ct());
        Assert.True(up.IsError != true);
        Assert.Equal(Session, Structured(up).GetProperty("sessionId").GetString());
    }

    [Fact]
    public async Task LostConnectionIsAnUnknownOutcomeAndIsNotRetried()
    {
        var pipe = NewPipe();
        var app = new FakeApp();
        PipeServer? server = null;
        app.Override = async r => { server!.DropConnections(); await Task.Delay(Timeout.Infinite); return Wire.Ok(r.RequestId, new JsonObject()); };
        server = PipeServer.Start(pipe, app.Handle);
        await using var _ = server;
        await using var client = await Connect(pipe);
        var r = await client.CallToolAsync("execute_script", new Dictionary<string, object?> { ["documentId"] = Doc, ["sessionId"] = Session, ["transactionId"] = Tx, ["baseRevision"] = 0, ["script"] = "move a dx=1mm dy=0mm" }, cancellationToken: Ct());
        Assert.True(r.IsError);
        var err = Structured(r).GetProperty("error");
        Assert.Equal("not_running", err.GetProperty("code").GetString());
        Assert.Equal("unknown", err.GetProperty("outcome").GetString()); // never claimed as a rollback
        Assert.Equal(1, app.Count("doc.executeScript")); // and not silently sent a second time
    }

    // ---- stdout discipline ---------------------------------------------------------------------

    [Fact]
    public async Task StdioHasNoLogs()
    {
        var pipe = NewPipe();
        var app = new FakeApp();
        await using var server = PipeServer.Start(pipe, app.Handle);
        var psi = new ProcessStartInfo("dotnet", $"\"{ShimDll()}\"")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false), UseShellExecute = false,
        };
        psi.Environment["DIAGRAM_PIPE"] = pipe;
        using var p = Process.Start(psi)!;
        var stderr = new StringBuilder();
        p.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (stderr) stderr.AppendLine(e.Data); };
        p.BeginErrorReadLine();
        var ct = Ct();
        var transcript = new List<string>();
        async Task<JsonDocument> Rpc(string line, bool reply = true)
        {
            await p.StandardInput.WriteLineAsync(line.AsMemory(), ct);
            await p.StandardInput.FlushAsync(ct);
            if (!reply) return JsonDocument.Parse("{}");
            var l = await p.StandardOutput.ReadLineAsync(ct) ?? throw new EndOfStreamException();
            transcript.Add(l);
            return JsonDocument.Parse(l); // a log line on stdout would throw here
        }
        try
        {
            using var init = await Rpc("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}""");
            Assert.True(init.RootElement.TryGetProperty("result", out _));
            await Rpc("""{"jsonrpc":"2.0","method":"notifications/initialized"}""", reply: false);
            const string secret = "TOPSECRET-DOCUMENT-TEXT";
            using var call = await Rpc("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_script\",\"arguments\":{\"documentId\":\"" + Doc + "\",\"sessionId\":\"" + Session + "\",\"transactionId\":\"" + Tx + "\",\"baseRevision\":0,\"script\":\"add shape text=\\\"" + secret + "\\\"\"}}}");
            Assert.True(call.RootElement.TryGetProperty("result", out _));
            Assert.All(transcript, l => Assert.Contains("\"jsonrpc\":\"2.0\"", l));
            string err; lock (stderr) err = stderr.ToString();
            Assert.Contains("Diagram.Mcp starting", err);
            Assert.DoesNotContain(secret, err); // diagnostics never carry document text
        }
        finally { try { if (!p.HasExited) p.Kill(true); } catch { } }
    }
}

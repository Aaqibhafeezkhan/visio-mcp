using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using static Diagram.Visio.Vx;

namespace Diagram.Visio;

/// <summary>
/// Reads a .vsdx into a candidate canonical document. It understands the Visio XML for the supported object kinds, so it reads files this
/// application wrote (including after Visio saved them) as well as ordinary Visio drawings built from basic shapes, connectors and
/// pictures. Anything else is brought in as a clearly marked placeholder with a diagnostic, never as something that looks supported.
/// The package is checked first and nothing in it is trusted: ids, sizes and relationships are all validated.
/// </summary>
public sealed class NativeVsdxImporter : IVsdxImporter
{
    public Task<Result<ImportResult>> ImportAsync(Stream package, ImportOptions options, CancellationToken ct) => Task.FromResult(Import(package, options));

    public Result<ImportResult> Import(Stream package, ImportOptions options)
    {
        var opened = PackageGuard.Open(package, options);
        if (!opened.IsOk) return Result<ImportResult>.Fail(opened.Error!);
        using var pkg = opened.Value;
        try { return new Reader(pkg, options).Run(); }
        catch (ImportFailure f) { return Result<ImportResult>.Fail(f.Code, f.Message); }
        catch (Exception e) when (e is JsonException or FormatException or KeyNotFoundException or InvalidOperationException)
        {
            return Result<ImportResult>.Fail("invalid_request", "the file could not be read as a diagram: " + e.Message);
        }
    }

    sealed class ImportFailure(string code, string message) : Exception(message) { public string Code { get; } = code; }

    // ============================================================================================================
    sealed class Reader
    {
        readonly GuardedPackage pkg;
        readonly ImportOptions options;
        readonly List<Diagnostic> diag = new();
        readonly IdentityMap identity;
        readonly Dictionary<string, ImportedBlob> blobs = new();
        readonly Dictionary<string, string> faces = new();
        readonly Dictionary<string, Style> styles = new();
        readonly Dictionary<string, JsonObject> assetsBySha = new();
        readonly Dictionary<string, JsonObject> catalogue = new(); // from the document sheet, by sha of the asset as exported
        int shapeCount;

        public Reader(GuardedPackage pkg, ImportOptions options)
        {
            this.pkg = pkg; this.options = options;
            identity = new IdentityMap(pkg.Sha256);
            diag.AddRange(pkg.Diagnostics);
        }

        void Note(string code, string message, string? pageId = null, string? elementId = null, string? shape = null, string? action = null, string severity = "warning") =>
            diag.Add(new Diagnostic { Severity = severity, Code = code, Message = message, PageId = pageId, ElementId = elementId, SourceShape = shape, Action = action });

        XDocument Xml(string part) { var r = pkg.ReadXml(part); if (!r.IsOk) throw new ImportFailure(r.Error!.Code, r.Error.Message); return r.Value; }

        // ---------------------------------------------------------------- relationships
        record Rel(string Id, string Type, string? Target);

        List<Rel> RelsOf(string part)
        {
            var dir = part.Contains('/') ? part[..part.LastIndexOf('/')] : "";
            var name = part[(part.LastIndexOf('/') + 1)..];
            var relPart = (dir.Length > 0 ? dir + "/" : "") + "_rels/" + name + ".rels";
            if (!pkg.Has(relPart)) return [];
            var list = new List<Rel>();
            foreach (var r in Xml(relPart).Descendants(Rels + "Relationship"))
            {
                var external = string.Equals((string?)r.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase);
                var target = (string?)r.Attribute("Target") ?? "";
                if (external) { Note("external_relationship_ignored", $"A link to {Shorten(target)} was not followed.", severity: "info"); list.Add(new((string)r.Attribute("Id")!, (string?)r.Attribute("Type") ?? "", null)); continue; }
                var resolved = PackageGuard.ResolveTarget(part, target, false);
                if (!resolved.IsOk) throw new ImportFailure("invalid_request", resolved.Error!.Message);
                list.Add(new((string)r.Attribute("Id")!, (string?)r.Attribute("Type") ?? "", resolved.Value));
            }
            return list;
        }
        static string Shorten(string s) => s.Length > 60 ? s[..60] + "…" : s;

        // ---------------------------------------------------------------- masters (stencil shapes)
        string? mastersPart;
        readonly Dictionary<string, XElement?> masterShapes = new();
        readonly HashSet<string> masterNotes = new();

        XElement? MasterRoot(string masterId)
        {
            if (masterShapes.TryGetValue(masterId, out var cached)) return cached;
            XElement? found = null;
            if (mastersPart is not null && pkg.Has(mastersPart))
            {
                var el = Xml(mastersPart).Descendants(V + "Master").FirstOrDefault(x => (string?)x.Attribute("ID") == masterId);
                var rid = (string?)el?.Element(V + "Rel")?.Attribute(R + "id");
                var part = RelsOf(mastersPart).FirstOrDefault(r => r.Id == rid)?.Target;
                if (part is not null && pkg.Has(part)) found = Xml(part).Root?.Element(V + "Shapes")?.Elements(V + "Shape").FirstOrDefault();
                if (found is not null && masterNotes.Add(masterId))
                    Note("master_inlined", $"Shapes from the Visio stencil master '{(string?)el?.Attribute("NameU") ?? masterId}' were imported as ordinary shapes; their link to the master is not kept.", severity: "info");
            }
            return masterShapes[masterId] = found;
        }

        /// <summary>A shape dropped from a stencil stores only what differs from its master. Fill in the rest from the master so size, outline and ports are known.</summary>
        void InheritFromMasters(IEnumerable<XElement> top, int depth = 0)
        {
            foreach (var s in top) Inherit(s, null, depth);
        }

        void Inherit(XElement s, XElement? parentSrc, int depth)
        {
            if (depth > 64) return;
            XElement? src = null;
            if ((string?)s.Attribute("Master") is { } m) src = MasterRoot(m);
            else if (parentSrc is not null && (string?)s.Attribute("MasterShape") is { } ms) src = parentSrc.DescendantsAndSelf(V + "Shape").FirstOrDefault(x => (string?)x.Attribute("ID") == ms);
            if (src is not null) MergeFromMaster(s, src);
            foreach (var c in s.Element(V + "Shapes")?.Elements(V + "Shape") ?? []) Inherit(c, src ?? parentSrc, depth + 1);
        }

        static void MergeFromMaster(XElement s, XElement src)
        {
            foreach (var a in new[] { "LineStyle", "FillStyle", "TextStyle" })
                if (s.Attribute(a) is null && src.Attribute(a) is { } av) s.SetAttributeValue(a, av.Value);
            var have = s.Elements(V + "Cell").Select(c => (string?)c.Attribute("N")).ToHashSet();
            var added = new List<XElement>();
            foreach (var c in src.Elements(V + "Cell"))
                if (!have.Contains((string?)c.Attribute("N"))) { var copy = new XElement(c); s.Add(copy); added.Add(copy); }
            foreach (var sec in src.Elements(V + "Section"))
            {
                var key = (string?)sec.Attribute("N"); var ix = (string?)sec.Attribute("IX");
                var mine = s.Elements(V + "Section").FirstOrDefault(x => (string?)x.Attribute("N") == key && (string?)x.Attribute("IX") == ix);
                if (mine is null) { var copy = new XElement(sec); s.Add(copy); added.Add(copy); continue; }
                foreach (var row in sec.Elements(V + "Row"))
                {
                    var t = (string?)row.Attribute("T"); var rix = (string?)row.Attribute("IX"); var rn = (string?)row.Attribute("N");
                    var same = mine.Elements(V + "Row").FirstOrDefault(r => (string?)r.Attribute("T") == t && (string?)r.Attribute("IX") == rix && (string?)r.Attribute("N") == rn);
                    if (same is null) { var copy = new XElement(row); mine.Add(copy); added.Add(copy); continue; }
                    // a row the shape overrides may state only some of its cells (a LineTo with just a Y): the rest come from the master's row
                    var rowHave = same.Elements(V + "Cell").Select(c => (string?)c.Attribute("N")).ToHashSet();
                    foreach (var c in row.Elements(V + "Cell"))
                        if (!rowHave.Contains((string?)c.Attribute("N"))) { var copy = new XElement(c); same.Add(copy); added.Add(copy); }
                }
                // rows from the master were appended; put every row back in its own order (a path must open with its MoveTo)
                static double Ix(XElement e) => double.TryParse((string?)e.Attribute("IX"), System.Globalization.NumberStyles.Float, Inv, out var v) ? v : double.MaxValue;
                if (mine.Elements(V + "Row").Skip(1).Any()) mine.ReplaceNodes(mine.Elements().Select((e, i) => (e, i)).OrderBy(x => x.e.Name == V + "Row" ? 1 : 0).ThenBy(x => x.e.Name == V + "Row" ? Ix(x.e) : 0).ThenBy(x => x.i).Select(x => (object)x.e));
            }
            // inherited cells hold the master's values; where they are proportional to the shape's size, restate them for this instance
            double Size(string n) => double.TryParse(Own(s, n), System.Globalization.NumberStyles.Float, Inv, out var v) ? v : 0;
            var w = Size("Width"); var h = Size("Height");
            foreach (var cell in added.SelectMany(e => e.Name == V + "Cell" ? new[] { e } : e.Descendants(V + "Cell")))
            {
                var f = (string?)cell.Attribute("F");
                if (f is null) continue;
                var m = System.Text.RegularExpressions.Regex.Match(f, @"^(Width|Height)(?:\*(-?[0-9.]+))?$");
                if (!m.Success) continue;
                var factor = m.Groups[2].Success ? double.Parse(m.Groups[2].Value, Inv) : 1.0;
                cell.SetAttributeValue("V", ((m.Groups[1].Value == "Width" ? w : h) * factor).ToString("R", Inv));
            }
        }

        // ---------------------------------------------------------------- styles and cells
        sealed record Style(string? BasedOn, Dictionary<string, string> Cells, Dictionary<string, string> Char);

        void ReadStyles(XDocument docXml)
        {
            foreach (var f in docXml.Descendants(V + "FaceName")) faces[(string?)f.Attribute("ID") ?? "0"] = (string?)f.Attribute("Name") ?? "Segoe UI";
            foreach (var s in docXml.Descendants(V + "StyleSheet"))
            {
                var cells = s.Elements(V + "Cell").Where(c => c.Attribute("N") != null && c.Attribute("V") != null).ToDictionary(c => (string)c.Attribute("N")!, c => (string)c.Attribute("V")!, StringComparer.Ordinal);
                var ch = s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "Character").Elements(V + "Row").FirstOrDefault()?.Elements(V + "Cell")
                    .Where(c => c.Attribute("N") != null && c.Attribute("V") != null).ToDictionary(c => (string)c.Attribute("N")!, c => (string)c.Attribute("V")!) ?? new Dictionary<string, string>();
                styles[(string?)s.Attribute("ID") ?? "0"] = new Style((string?)s.Attribute("BasedOn"), cells, ch);
            }
        }

        string? FromStyle(string? styleId, string cell, bool character = false)
        {
            for (var id = styleId; id is not null && styles.TryGetValue(id, out var st);)
            {
                var d = character ? st.Char : st.Cells;
                if (d.TryGetValue(cell, out var v)) return v;
                id = st.BasedOn;
            }
            return null;
        }

        static string? Own(XElement shape, string cell) => shape.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == cell)?.Attribute("V")?.Value;
        static string? OwnF(XElement shape, string cell) => shape.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == cell)?.Attribute("F")?.Value;

        string? Line(XElement shape, string cell) => Own(shape, cell) ?? FromStyle((string?)shape.Attribute("LineStyle"), cell);
        string? FillC(XElement shape, string cell) => Own(shape, cell) ?? FromStyle((string?)shape.Attribute("FillStyle"), cell);

        static Dictionary<string, string> UserCells(XElement shape)
        {
            var d = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var sec in shape.Elements(V + "Section").Where(s => (string?)s.Attribute("N") == "User"))
                foreach (var row in sec.Elements(V + "Row"))
                {
                    var n = (string?)row.Attribute("N");
                    var v = row.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == "Value")?.Attribute("V")?.Value;
                    if (n is not null && v is not null) d[n] = v;
                }
            return d;
        }

        static readonly string[] Palette = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#c0c0c0", "#e6e6e6",
            "#cdcdcd", "#b3b3b3", "#9a9a9a", "#808080", "#666666", "#4d4d4d", "#333333", "#1a1a1a"];

        string Colour(string? v, string fallback, string? elementId, string? pageId)
        {
            if (v is null) return fallback;
            if (v.Length == 7 && v[0] == '#' && v.Skip(1).All(Uri.IsHexDigit)) return v.ToLowerInvariant();
            if (int.TryParse(v, System.Globalization.NumberStyles.Integer, Inv, out var i) && i >= 0 && i < Palette.Length) return Palette[i];
            Note("colour_approximated", $"The colour '{v}' is not a plain RGB value and was replaced with {fallback}.", pageId, elementId, action: "colour approximated", severity: "info");
            return fallback;
        }

        // ---------------------------------------------------------------- run
        public Result<ImportResult> Run()
        {
            // main document part
            var root = RelsOf("_rels/.rels".Replace("_rels/.rels", "x")).Count; _ = root;
            var rootRels = new List<Rel>();
            foreach (var r in Xml("_rels/.rels").Descendants(Rels + "Relationship"))
            {
                var res = PackageGuard.ResolveTarget("x", (string?)r.Attribute("Target") ?? "", string.Equals((string?)r.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase));
                if (!res.IsOk) throw new ImportFailure("invalid_request", res.Error!.Message);
                rootRels.Add(new((string)r.Attribute("Id")!, (string?)r.Attribute("Type") ?? "", res.Value));
            }
            var mainPart = rootRels.FirstOrDefault(r => r.Type.EndsWith("/document", StringComparison.Ordinal))?.Target ?? "visio/document.xml";
            if (!pkg.Has(mainPart)) throw new ImportFailure("invalid_request", "the package has no Visio document part");
            var docXml = Xml(mainPart);
            ReadStyles(docXml);
            var docUser = UserCells(docXml.Descendants(V + "DocumentSheet").FirstOrDefault() ?? new XElement("x"));
            foreach (var kv in docUser.Where(k => k.Key.StartsWith("AgentAsset", StringComparison.Ordinal) && k.Key != "AgentAssetId"))
            {
                try { var j = JsonNode.Parse(kv.Value)!.AsObject(); if (j["sha"] is JsonNode sha) catalogue[sha.GetValue<string>()] = j; } catch (JsonException) { }
            }

            var docRels = RelsOf(mainPart);
            mastersPart = docRels.FirstOrDefault(r => r.Type.EndsWith("/masters", StringComparison.Ordinal))?.Target;
            var pagesPart = docRels.FirstOrDefault(r => r.Type.EndsWith("/pages", StringComparison.Ordinal))?.Target ?? throw new ImportFailure("invalid_request", "the package has no pages part");
            var pagesXml = Xml(pagesPart);
            var pageRels = RelsOf(pagesPart);
            var pageEls = pagesXml.Descendants(V + "Page").ToList();
            if (pageEls.Count == 0) throw new ImportFailure("invalid_request", "the drawing has no pages");
            if (pageEls.Count > options.MaxPages) throw new ImportFailure("limit_exceeded", $"the drawing has more than {options.MaxPages} pages");

            var pages = new JsonArray();
            for (var pi = 0; pi < pageEls.Count; pi++)
            {
                var pe = pageEls[pi];
                var rid = (string?)pe.Element(V + "Rel")?.Attribute(R + "id");
                var part = pageRels.FirstOrDefault(r => r.Id == rid)?.Target;
                if (part is null || !pkg.Has(part)) { Note("page_missing", $"Page {pi + 1} has no content part and was imported empty.", action: "page empty"); }
                pages.Add(new PageReader(this, pe, part is not null && pkg.Has(part) ? part : null, pi).Read());
            }

            var title = docUser.GetValueOrDefault("AgentTitle") ?? CoreTitle() ?? "Untitled";
            var metadata = new JsonObject();
            if (docUser.TryGetValue("AgentDocumentMetadata", out var md)) { try { foreach (var kv in JsonNode.Parse(md)!.AsObject()) metadata[kv.Key] = kv.Value?.GetValue<string>() ?? ""; } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }
            var docId = IdentityMap.IsUuid(docUser.GetValueOrDefault("AgentDocumentId")) ? docUser["AgentDocumentId"].ToLowerInvariant() : IdentityMap.V5($"{pkg.Sha256}/document");
            var json = new JsonObject
            {
                ["schemaVersion"] = 1, ["id"] = docId, ["title"] = title.Length > 512 ? title[..512] : title, ["revision"] = 0, ["pages"] = pages,
                ["assets"] = new JsonArray(assetsBySha.Values.Select(a => (JsonNode)a.DeepClone()).ToArray()), ["metadata"] = metadata, ["source"] = new JsonObject { ["format"] = "vsdx" },
            };
            DiagramDocument doc;
            try { doc = json.Deserialize<DiagramDocument>(ContractJson.Options)!; }
            catch (JsonException e) { throw new ImportFailure("invalid_request", "the drawing does not fit the diagram model: " + e.Message); }
            return Result<ImportResult>.Ok(new ImportResult(doc, blobs.Values.ToList(), diag, identity.Report()));
        }

        string? CoreTitle()
        {
            if (!pkg.Has("docProps/core.xml")) return null;
            var r = pkg.ReadXml("docProps/core.xml");
            return r.IsOk ? r.Value.Descendants().FirstOrDefault(e => e.Name.LocalName == "title")?.Value : null;
        }

        // =================================================================================================================
        sealed class PageReader(Reader rd, XElement pageEl, string? contentPart, int pageIndex)
        {
            readonly Dictionary<string, string> idByShape = new();            // visio shape id -> canonical id
            readonly Dictionary<string, XElement> shapeById = new();
            readonly Dictionary<string, List<(string Id, double X, double Y)>> portsOf = new();
            readonly Dictionary<string, string> layerIdByIndex = new();
            readonly List<JsonObject> elements = new();
            readonly Dictionary<string, JsonObject> elementById = new();
            readonly List<(JsonObject Group, XElement Shape, string[] ConnectorMembers)> groups = new();
            readonly Dictionary<string, Dictionary<string, string>> userByShape = new();
            readonly Dictionary<string, (string Page, string Text)> placeholders = new();
            string pageId = "";
            double pageHeightPt;
            int zCounter;
            List<Rel> rels = [];
            readonly HashSet<string> aliases = new(StringComparer.Ordinal);

            void Note(string code, string message, string? elementId = null, string? shape = null, string? action = null, string severity = "warning") =>
                rd.Note(code, message, pageId, elementId, shape, action, severity);

            public JsonObject Read()
            {
                var sheet = pageEl.Element(V + "PageSheet") ?? new XElement(V + "PageSheet");
                var user = UserCells(sheet);
                pageId = rd.identity.Resolve(user.GetValueOrDefault("AgentPageId"), $"page{pageIndex}", "page");
                var widthIn = D(Own(sheet, "PageWidth"), 11.692913385826772); var heightIn = D(Own(sheet, "PageHeight"), 8.267716535433072);
                var wPt = Math.Clamp(widthIn * PtPerInch, 1, 14400); pageHeightPt = Math.Clamp(heightIn * PtPerInch, 1, 14400);
                if (widthIn * PtPerInch > 14400 || heightIn * PtPerInch > 14400) Note("page_size_clamped", "The page is larger than the editor allows and was reduced.", action: "page size clamped");

                var grid = new JsonObject { ["visible"] = true, ["spacingPt"] = Math.Max(0.5, D(Own(sheet, "XGridSpacing"), 0.19685) * PtPerInch), ["snap"] = true };
                if (user.TryGetValue("AgentGrid", out var g)) { try { var j = JsonNode.Parse(g)!.AsObject(); grid["visible"] = j["visible"]?.GetValue<bool>() ?? true; grid["spacingPt"] = Math.Max(0.5, j["spacingPt"]?.GetValue<double>() ?? 14.17); grid["snap"] = j["snap"]?.GetValue<bool>() ?? true; } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }
                JsonNode background = new JsonObject { ["kind"] = "solid", ["colour"] = "#ffffff", ["opacity"] = 1 };
                if (user.TryGetValue("AgentBackground", out var bgs)) { try { var j = JsonNode.Parse(bgs)!.AsObject(); background = j["none"] is not null ? new JsonObject { ["kind"] = "none" } : new JsonObject { ["kind"] = "solid", ["colour"] = j["colour"]?.GetValue<string>() ?? "#ffffff", ["opacity"] = j["opacity"]?.GetValue<double>() ?? 1 }; } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }

                var layers = ReadLayers(sheet, user);
                if (contentPart is not null) ReadContent(contentPart, user);
                return new JsonObject
                {
                    ["id"] = pageId, ["name"] = Trim((string?)pageEl.Attribute("Name") ?? (string?)pageEl.Attribute("NameU") ?? $"Page {pageIndex + 1}", 256), ["widthPt"] = wPt, ["heightPt"] = pageHeightPt,
                    ["background"] = background, ["grid"] = grid, ["guides"] = guides, ["layers"] = layers, ["elements"] = new JsonArray(elements.Select(e => (JsonNode)e).ToArray()),
                };
            }

            static string Trim(string s, int max) => s.Length > max ? s[..max] : s.Length == 0 ? "Untitled" : s;
            readonly JsonArray guides = new();
            readonly List<JsonObject> connectorEls = new();
            /// <summary>Where Visio drew each connector's two ends, whether or not they are glued: what a T-junction is measured against.</summary>
            readonly Dictionary<string, ((double X, double Y) From, (double X, double Y) To)> drawnEnds = new();

            JsonArray ReadLayers(XElement sheet, Dictionary<string, string> user)
            {
                var result = new JsonArray();
                var rows = sheet.Elements(V + "Section").FirstOrDefault(s => (string?)s.Attribute("N") == "Layer")?.Elements(V + "Row").ToList() ?? [];
                var saved = new List<(string Id, string Name)>();
                if (user.TryGetValue("AgentLayers", out var al)) { try { foreach (var n in JsonNode.Parse(al)!.AsArray()) saved.Add((n!["id"]!.GetValue<string>(), n["name"]!.GetValue<string>())); } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }
                for (var i = 0; i < rows.Count; i++)
                {
                    var r = rows[i];
                    string? C(string n) => r.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V")?.Value;
                    var name = Trim(C("Name") ?? C("NameUniv") ?? $"Layer {i + 1}", 256);
                    // match by name first (Visio re-indexes rows), then by position; a duplicate name falls back to position
                    var byName = saved.Where(s => s.Name == name).ToList();
                    var match = byName.Count == 1 ? byName[0] : (i < saved.Count && saved[i].Name == name ? saved[i] : default);
                    var id = rd.identity.Resolve(match.Id, $"page{pageIndex}/layer{i}", "layer");
                    layerIdByIndex[i.ToString(Inv)] = id;
                    var layer = new JsonObject { ["id"] = id, ["name"] = name, ["visible"] = C("Visible") != "0", ["locked"] = C("Lock") == "1", ["printable"] = C("Print") != "0", ["snap"] = C("Snap") != "0", ["glue"] = C("Glue") != "0" };
                    var colour = C("Color");
                    if (colour is { Length: 7 } && colour[0] == '#' && colour.Skip(1).All(Uri.IsHexDigit)) layer["colourOverride"] = colour.ToLowerInvariant();
                    result.Add(layer);
                }
                return result;
            }

            // ------------------------------------------------------------ content
            void ReadContent(string part, Dictionary<string, string> pageUser)
            {
                var content = rd.Xml(part);
                rels = rd.RelsOf(part);
                var top = content.Root?.Element(V + "Shapes")?.Elements(V + "Shape").ToList() ?? [];
                rd.InheritFromMasters(top);
                var all = new List<XElement>();
                void Collect(XElement s) { all.Add(s); foreach (var c in s.Element(V + "Shapes")?.Elements(V + "Shape") ?? []) Collect(c); }
                foreach (var s in top) Collect(s);
                rd.shapeCount += all.Count;
                if (rd.shapeCount > rd.options.MaxShapes) throw new ImportFailure("limit_exceeded", $"the drawing has more than {rd.options.MaxShapes} shapes");

                // identity first, in document order, so that a copied id is repaired on the later shape
                foreach (var s in all)
                {
                    var sid = (string?)s.Attribute("ID") ?? "";
                    shapeById[sid] = s;
                    var u = UserCells(s); userByShape[sid] = u;
                    idByShape[sid] = rd.identity.Resolve(u.GetValueOrDefault("AgentId"), $"page{pageIndex}/shape{sid}", "shape");
                    if (u.GetValueOrDefault("AgentKind") == "guide" || (string?)s.Attribute("Type") == "Guide") continue;
                    ReadPorts(s, sid, u);
                }

                var connects = content.Root?.Element(V + "Connects")?.Elements(V + "Connect").ToList() ?? [];
                foreach (var s in top) Walk(s, null, connects);

                // a connector's fallback box needs the shapes it is glued to, which may come later in the file
                foreach (var c in connectorEls) c["bounds"] = ConnectorBounds(c);
                RestoreAttachments();
                RestoreJoins();
                InferJoins();
                foreach (var (group, shape, connMembers) in groups)
                {
                    var members = (JsonArray)group["childIds"]!;
                    foreach (var cm in connMembers) if (IdentityMap.IsUuid(cm) && elementById.ContainsKey(cm.ToLowerInvariant()) && elementById[cm.ToLowerInvariant()]["kind"]!.GetValue<string>() == "connector") members.Add(cm.ToLowerInvariant());
                }
                // group bounds are derived from their members; groups stack with their topmost member
                foreach (var (group, _, _) in groups.AsEnumerable().Reverse()) FinishGroup(group);
                NormalizeStackingLevels();
                ResolveContainers();
                _ = pageUser;
            }

            // ------------------------------------------------------------ coordinates
            sealed record Xf(double PinX, double PinY, double LocX, double LocY, double Angle, double Width, double Height, Xf? Parent);

            Xf Transform(XElement s, Xf? parent) => new(D(Own(s, "PinX")), D(Own(s, "PinY")), D(Own(s, "LocPinX"), D(Own(s, "Width")) / 2), D(Own(s, "LocPinY"), D(Own(s, "Height")) / 2), D(Own(s, "Angle")), D(Own(s, "Width")), D(Own(s, "Height")), parent);

            /// <summary>A point in a shape's own local space (inches, origin bottom left) as a point on the page (inches, y up).</summary>
            static (double X, double Y) ToPage(Xf x, double lx, double ly)
            {
                var dx = lx - x.LocX; var dy = ly - x.LocY;
                var c = Math.Cos(x.Angle); var s = Math.Sin(x.Angle);
                var px = x.PinX + dx * c - dy * s; var py = x.PinY + dx * s + dy * c;
                return x.Parent is null ? (px, py) : ToPage(x.Parent, px, py);
            }

            static double TotalAngle(Xf x) => x.Angle + (x.Parent is null ? 0 : TotalAngle(x.Parent));

            (double X, double Y) PagePt((double X, double Y) inches) => (inches.X * PtPerInch, pageHeightPt - inches.Y * PtPerInch);

            static double NormaliseDeg(double d) { d %= 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return Math.Abs(d) < 1e-9 ? 0 : d; }

            JsonObject Bounds(Xf x)
            {
                var (cx, cy) = PagePt(ToPage(x, x.Width / 2, x.Height / 2));
                var w = x.Width * PtPerInch; var h = x.Height * PtPerInch;
                return new JsonObject { ["x"] = cx - w / 2, ["y"] = cy - h / 2, ["width"] = w, ["height"] = h };
            }

            /// <summary>Visio draws a vertical or horizontal rule as a shape with no width or no height; the editor needs a positive size, so it becomes a hairline around the same centre line.</summary>
            JsonObject Hairline(JsonObject b, string id, string sid)
            {
                const double Min = 0.01;
                var changed = false;
                foreach (var (pos, size) in new[] { ("x", "width"), ("y", "height") })
                {
                    var length = b[size]!.GetValue<double>();
                    if (length >= Min) continue;
                    b[pos] = b[pos]!.GetValue<double>() + length / 2 - Min / 2; b[size] = Min; changed = true;
                }
                if (changed) Note("zero_size_adjusted", "This shape has no width or no height in Visio (a rule); it was given a hairline size so the editor can hold it.", id, sid, "size adjusted", "info");
                return b;
            }

            // ------------------------------------------------------------ walk
            void Walk(XElement s, Xf? parent, List<XElement> connects)
            {
                var sid = (string?)s.Attribute("ID") ?? "";
                var u = userByShape[sid];
                var type = (string?)s.Attribute("Type") ?? "Shape";
                if (type == "Guide" || u.GetValueOrDefault("AgentKind") == "guide") { ReadGuide(s, sid); return; }
                var xf = Transform(s, parent);
                if (D(Own(s, "FlipX")) != 0 || D(Own(s, "FlipY")) != 0) Note("flip_not_supported", "A flipped shape was imported unflipped.", idByShape[sid], sid, "flip dropped");
                if (type == "Group" && u.GetValueOrDefault("msvStructureType") == "Container") { ReadContainerGroup(s, sid, u, xf); return; }
                if (type == "Group") { ReadGroup(s, sid, u, xf, connects); return; }
                if (type == "Foreign") { ReadPicture(s, sid, u, xf); return; }
                if (IsConnector(s)) { ReadConnector(s, sid, u, xf, connects); return; }
                ReadShape(s, sid, u, xf);
            }

            static bool IsConnector(XElement s) => Own(s, "BeginX") is not null && Own(s, "EndX") is not null || Own(s, "ObjType") == "2";

            // ------------------------------------------------------------ common properties
            JsonObject Base(XElement s, string sid, Dictionary<string, string> u, string kind, Xf xf)
            {
                var id = idByShape[sid];
                var o = new JsonObject
                {
                    ["id"] = id, ["kind"] = kind, ["layerIds"] = LayerIds(s), ["zIndex"] = 0, ["locked"] = false, ["hidden"] = false, ["bounds"] = kind is "shape" or "image" ? Hairline(Bounds(xf), id, sid) : Bounds(xf),
                    ["rotationDeg"] = NormaliseDeg(-TotalAngle(xf) * 180 / Math.PI), ["metadata"] = new JsonObject(),
                };
                if (u.TryGetValue("AgentLevel", out var rawLevel))
                {
                    if (int.TryParse(rawLevel, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var level) && level is >= -127 and <= 127)
                    {
                        if (level != 0) o["level"] = level;
                    }
                    else Note("level_invalid", $"The saved level '{rawLevel}' is outside the supported integer range; level 0 was used.", id, sid, "level reset");
                }
                var alias = u.GetValueOrDefault("AgentAlias");
                if (alias is { Length: > 0 and <= 128 })
                {
                    if (rd.catalogueSeenAlias(pageId, alias, aliases)) o["alias"] = alias;
                    else Note("alias_repeated", $"The alias \"{alias}\" is already used on this page; the later shape lost it.", id, sid, "alias dropped");
                }
                if (u.TryGetValue("AgentName", out var name) && name.Length <= 256) o["name"] = name;
                if (u.TryGetValue("AgentMetadata", out var meta)) { try { var m = new JsonObject(); foreach (var kv in JsonNode.Parse(meta)!.AsObject()) m[kv.Key] = kv.Value?.GetValue<string>() ?? ""; o["metadata"] = m; } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }
                var locks = new[] { "LockMoveX", "LockMoveY", "LockWidth", "LockHeight" }.All(n => Own(s, n) == "1");
                o["locked"] = u.GetValueOrDefault("AgentLocked") == "1" || locks;
                o["hidden"] = u.GetValueOrDefault("AgentHidden") == "1";
                return o;
            }

            JsonArray LayerIds(XElement s)
            {
                var arr = new JsonArray();
                var lm = Own(s, "LayerMember");
                if (string.IsNullOrEmpty(lm)) return arr;
                foreach (var part in lm.Split(';', StringSplitOptions.RemoveEmptyEntries))
                    if (layerIdByIndex.TryGetValue(part.Trim(), out var id) && !arr.Any(n => n!.GetValue<string>() == id)) arr.Add(id);
                return arr;
            }

            void Add(JsonObject el, int sz = 1)
            {
                el["zIndex"] = ++zCounter;
                elements.Add(el);
                elementById[el["id"]!.GetValue<string>()] = el;
                _ = sz;
            }

            // ------------------------------------------------------------ shapes
            void ReadShape(XElement s, string sid, Dictionary<string, string> u, Xf xf)
            {
                var hasGeometry = s.Elements(V + "Section").Any(x => (string?)x.Attribute("N") == "Geometry");
                var kindHint = u.GetValueOrDefault("AgentKind");
                var text = ReadText(s, u, idByShape[sid]);
                var fillNone = rd.FillC(s, "FillPattern") == "0";
                var lineNone = rd.Line(s, "LinePattern") == "0";
                var isText = kindHint == "text" || (kindHint is null && fillNone && lineNone && text is not null && hasGeometry);
                if (isText)
                {
                    var t = Base(s, sid, u, "text", xf);
                    t["text"] = text ?? DefaultText();
                    Add(t);
                    return;
                }
                var shape = Base(s, sid, u, "shape", xf);
                var geometry = ReadGeometryFor(s, sid, u, xf, hasGeometry);
                shape["geometry"] = geometry.Geometry;
                shape["style"] = Style(s, idByShape[sid], u);
                // a drawing made only of open lines (every outline marked NoFill) has nothing to fill; Visio draws it as a line
                var outlines = s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "Geometry").ToList();
                if (hasGeometry && !geometry.Placeholder && outlines.All(o => o.Elements(V + "Cell").Any(c => (string?)c.Attribute("N") == "NoFill" && (string?)c.Attribute("V") == "1")))
                    ((JsonObject)shape["style"]!)["fill"] = new JsonObject { ["kind"] = "none" };
                if (text is not null) shape["text"] = text;
                if (portsOf.TryGetValue(sid, out var ports) && ports.Count > 0) shape["ports"] = new JsonArray(ports.Select(p => (JsonNode)new JsonObject { ["id"] = p.Id, ["x"] = Math.Clamp(p.X, 0, 1), ["y"] = Math.Clamp(p.Y, 0, 1) }).ToArray());
                if (geometry.Placeholder) { ((JsonObject)shape["metadata"]!)["visio.unsupported"] = geometry.Why!; }
                Add(shape);
            }

            /// <summary>
            /// A linear Visio gradient (direction 0) as a gradient paint: angle in degrees and the stops in order. Other gradient types (radial, rectangular,
            /// path) are kept as the first stop's solid colour, and a note says so.
            /// </summary>
            JsonNode? ReadGradient(XElement s, string elementId)
            {
                var sid = (string?)s.Attribute("ID") ?? "";
                var dir = (int)D(rd.FillC(s, "FillGradientDir"), 0);
                var rows = s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "FillGradient").Elements(V + "Row").OrderBy(r => D((string?)r.Attribute("IX"), 0)).ToList();
                var stops = new List<(double Offset, string Colour, double Opacity)>();
                foreach (var row in rows)
                {
                    string? Cv(string n) => row.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V")?.Value;
                    stops.Add((Math.Clamp(D(Cv("GradientStopPosition"), 0), 0, 1), rd.Colour(Cv("GradientStopColor"), "#ffffff", elementId, pageId), Math.Clamp(1 - D(Cv("GradientStopColorTrans"), 0), 0, 1)));
                }
                if (stops.Count < 2) return null; // no stops written: Visio draws its own theme gradient, which is not a thing this file defines
                if (dir != 0)
                {
                    Note("gradient_approximated", "A radial or rectangular gradient fill is not supported; the first colour is used as a solid fill.", elementId, sid, "solid fill", "info");
                    return null;
                }
                stops = stops.Take(8).OrderBy(x => x.Offset).ToList();
                var angle = D(rd.FillC(s, "FillGradientAngle"), 0) * 180 / Math.PI;
                angle = Math.Round(angle % 360, 4);
                return new JsonObject
                {
                    ["kind"] = "linear-gradient", ["angleDeg"] = angle,
                    ["stops"] = new JsonArray(stops.Select(x => (JsonNode)new JsonObject { ["offset"] = Math.Round(x.Offset, 6), ["colour"] = x.Colour, ["opacity"] = Math.Round(x.Opacity, 6) }).ToArray()),
                };
            }

            JsonObject Style(XElement s, string elementId, Dictionary<string, string> u)
            {
                var fillColour = rd.Colour(rd.FillC(s, "FillForegnd"), "#ffffff", elementId, pageId);
                var fillTrans = D(rd.FillC(s, "FillForegndTrans"), 0);
                JsonNode fill = rd.FillC(s, "FillPattern") == "0" ? new JsonObject { ["kind"] = "none" } : new JsonObject { ["kind"] = "solid", ["colour"] = fillColour, ["opacity"] = Math.Round(Math.Clamp(1 - fillTrans, 0, 1), 6) };
                if (rd.FillC(s, "FillGradientEnabled") is "1" or "TRUE" && rd.FillC(s, "FillPattern") != "0" && ReadGradient(s, elementId) is { } gradient) fill = gradient;
                var lineColour = rd.Colour(rd.Line(s, "LineColor"), "#000000", elementId, pageId);
                var lineTrans = D(rd.Line(s, "LineColorTrans"), 0);
                var pattern = (int)D(rd.Line(s, "LinePattern"), 1);
                JsonNode stroke = pattern == 0 ? new JsonObject { ["kind"] = "none" } : new JsonObject { ["kind"] = "solid", ["colour"] = lineColour, ["opacity"] = Math.Round(Math.Clamp(1 - lineTrans, 0, 1), 6) };
                var width = D(rd.Line(s, "LineWeight"), 0.01) * PtPerInch;
                if (pattern == 0 && u.TryGetValue("AgentStrokeWidthPt", out var sw)) width = D(sw, width);
                var cap = (int)D(rd.Line(s, "LineCap"), 1) switch { 0 => "round", 2 => "square", _ => "butt" };
                return new JsonObject { ["fill"] = fill, ["stroke"] = stroke, ["strokeWidthPt"] = Math.Max(0, width), ["dash"] = DashOf(pattern == 0 ? 1 : pattern), ["lineCap"] = cap, ["lineJoin"] = "miter" };
            }

            static JsonObject DefaultText() => new() { ["value"] = "", ["fontFamily"] = "Segoe UI", ["fontSizePt"] = 12, ["bold"] = false, ["italic"] = false, ["underline"] = false, ["colour"] = "#000000", ["horizontalAlign"] = "center", ["verticalAlign"] = "middle", ["wrap"] = true, ["paddingPt"] = 4 };

            JsonObject? ReadText(XElement s, Dictionary<string, string> u, string elementId)
            {
                var textEl = s.Element(V + "Text");
                var value = textEl is null ? "" : string.Concat(textEl.Nodes().OfType<XText>().Select(t => t.Value));
                if (value.EndsWith('\n')) value = value[..^1]; // Visio keeps a closing paragraph mark
                value = value.Replace("\r\n", "\n");
                if (value.Length > 65536) { value = value[..65536]; Note("text_truncated", "Text longer than the editor allows was cut.", elementId, action: "text truncated"); }
                if (value.Length == 0 && u.GetValueOrDefault("AgentTextBlock") != "1") return null;
                var ch = s.Elements(V + "Section").FirstOrDefault(x => (string?)x.Attribute("N") == "Character")?.Elements(V + "Row").FirstOrDefault();
                string? C(string n) => ch?.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V")?.Value ?? rd.FromStyle((string?)s.Attribute("TextStyle"), n, character: true);
                var para = s.Elements(V + "Section").FirstOrDefault(x => (string?)x.Attribute("N") == "Paragraph")?.Elements(V + "Row").FirstOrDefault()?.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == "HorzAlign")?.Attribute("V")?.Value;
                var style = (int)D(C("Style"), 0);
                var size = D(C("Size"), 12.0 / PtPerInch) * PtPerInch;
                var font = C("Font");
                double Margin(string name) => Math.Max(0, D(Own(s, name), 4.0 / PtPerInch) * PtPerInch);
                var margin = Margin("LeftMargin");
                double top = Margin("TopMargin"), right = Margin("RightMargin"), bottom = Margin("BottomMargin");
                var txtAngle = D(Own(s, "TxtAngle"), 0);
                var turned = Math.Abs(((txtAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI / 2) < 0.01;
                var text = new JsonObject
                {
                    ["value"] = value, ["fontFamily"] = font is not null && rd.faces.TryGetValue(font, out var face) ? Trim(face, 128) : "Segoe UI", ["fontSizePt"] = Math.Clamp(size, 1, 1000),
                    ["bold"] = (style & 1) != 0, ["italic"] = (style & 2) != 0, ["underline"] = (style & 4) != 0, ["colour"] = rd.Colour(C("Color"), "#000000", elementId, pageId),
                    ["horizontalAlign"] = para switch { "0" => "left", "2" => "right", _ => "center" }, ["verticalAlign"] = D(Own(s, "VerticalAlign"), 1) switch { 0 => "top", 2 => "bottom", _ => "middle" },
                    ["wrap"] = u.GetValueOrDefault("AgentNoWrap") != "1", ["paddingPt"] = margin,
                };
                if (Math.Abs(top - margin) > 1e-6 || Math.Abs(right - margin) > 1e-6 || Math.Abs(bottom - margin) > 1e-6)
                    text["insetsPt"] = new JsonObject { ["top"] = top, ["right"] = right, ["bottom"] = bottom, ["left"] = margin };
                if (turned) text["orientation"] = "vertical";
                return text;
            }

            // ------------------------------------------------------------ geometry
            sealed record GeoResult(JsonObject Geometry, bool Placeholder, string? Why);

            GeoResult ReadGeometryFor(XElement s, string sid, Dictionary<string, string> u, Xf xf, bool hasGeometry)
            {
                var id = idByShape[sid];
                if (!hasGeometry)
                {
                    var master = (string?)s.Attribute("Master");
                    Note("unsupported_shape", master is not null ? "This shape comes from a Visio master (stencil) that is not supported; it is shown as a marked placeholder." : "This shape has no outline; it is shown as a marked placeholder.", id, sid, "placeholder rectangle");
                    return new GeoResult(new JsonObject { ["preset"] = "rectangle" }, true, master is not null ? "stencil master" : "no outline");
                }
                var sections = ReadSections(s, xf.Width, xf.Height, id, sid);
                var rounding = D(Own(s, "Rounding"), 0) * PtPerInch;
                var sig = GeometryMap.Signature(sections, xf.Width, xf.Height);
                var presetName = u.GetValueOrDefault("AgentPreset");
                if (presetName is not null && presetName != "svgPath" && presetName != "text" && presetName != "rounded-rectangle" && sig == GeometryMap.Signature(GeometryMap.ForPreset(presetName), xf.Width, xf.Height) && presetName != "rectangle")
                    return new GeoResult(new JsonObject { ["preset"] = presetName }, false, null);
                if (sig == GeometryMap.Signature(GeometryMap.ForPreset("rectangle")))
                {
                    if (rounding > 0.01 || presetName == "rounded-rectangle")
                    {
                        var g = new JsonObject { ["preset"] = "rounded-rectangle" };
                        if (rounding > 0.01) g["cornerRadiusPt"] = rounding; else if (u.TryGetValue("AgentCornerRadiusPt", out var cr)) g["cornerRadiusPt"] = D(cr);
                        return new GeoResult(g, false, null);
                    }
                    return new GeoResult(new JsonObject { ["preset"] = "rectangle" }, false, null);
                }
                if (sig == GeometryMap.Signature(GeometryMap.ForPreset("ellipse"))) return new GeoResult(new JsonObject { ["preset"] = "ellipse" }, false, null);
                if (presetName == "svgPath" && u.TryGetValue("AgentGeomSig", out var stored) && stored == sig && u.TryGetValue("AgentSvgPath", out var original))
                    return new GeoResult(new JsonObject { ["svgPath"] = original }, false, null);
                // anything else: keep the outline as a restricted path, and say it was converted
                var path = GeometryMap.ToSvgPath(sections, xf.Width > 0 ? xf.Width : 1, xf.Height > 0 ? xf.Height : 1); // a rule has no width or no height; the fractions were already made against 1
                if (path.Length == 0 || path.Length > 65536) { Note("unsupported_shape", "The outline of this shape is too complex; it is shown as a marked placeholder.", id, sid, "placeholder rectangle"); return new GeoResult(new JsonObject { ["preset"] = "rectangle" }, true, "outline too complex"); }
                Note("outline_converted", "The outline is not one of the editor's presets and was converted to a custom path.", id, sid, "custom path", "info");
                return new GeoResult(new JsonObject { ["svgPath"] = path }, false, null);
            }

            IReadOnlyList<GeoSection> ReadSections(XElement s, double wIn, double hIn, string elementId, string sid)
            {
                var result = new List<GeoSection>();
                var w = wIn > 0 ? wIn : 1; var h = hIn > 0 ? hIn : 1;
                foreach (var sec in s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "Geometry"))
                {
                    if (sec.Elements(V + "Cell").Any(c => (string?)c.Attribute("N") == "NoShow" && (string?)c.Attribute("V") == "1") && !s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "Geometry").Skip(1).Any()) { /* hidden outline still counts as geometry */ }
                    var noFill = sec.Elements(V + "Cell").Any(c => (string?)c.Attribute("N") == "NoFill" && (string?)c.Attribute("V") == "1");
                    var rows = new List<GeoRow>();
                    double lastX = 0, lastY = 0;
                    Frac Fr(double x, double y) => new(x / w, 1 - y / h);
                    foreach (var row in sec.Elements(V + "Row"))
                    {
                        if ((string?)row.Attribute("Del") == "1") continue;
                        var t = (string?)row.Attribute("T") ?? "";
                        double Cv(string n, double fb) => D(row.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V")?.Value, fb);
                        switch (t)
                        {
                            case "MoveTo": lastX = Cv("X", lastX); lastY = Cv("Y", lastY); rows.Add(new MoveRow(Fr(lastX, lastY))); break;
                            case "LineTo": lastX = Cv("X", lastX); lastY = Cv("Y", lastY); rows.Add(new LineRow(Fr(lastX, lastY))); break;
                            case "RelMoveTo": lastX = Cv("X", 0) * w; lastY = Cv("Y", 0) * h; rows.Add(new MoveRow(Fr(lastX, lastY))); break;
                            case "RelLineTo": lastX = Cv("X", 0) * w; lastY = Cv("Y", 0) * h; rows.Add(new LineRow(Fr(lastX, lastY))); break;
                            case "Ellipse":
                            {
                                var cx = Cv("X", w / 2); var cy = Cv("Y", h / 2);
                                rows.Add(new EllipseRow(Fr(cx, cy).With(), Math.Abs(Cv("A", cx + w / 2) - cx) / w, Math.Abs(Cv("D", cy + h / 2) - cy) / h));
                                break;
                            }
                            case "ArcTo":
                            {
                                // kept as an arc (not flattened) so a native outline can still be recognised as one of the presets
                                var x1 = Cv("X", lastX); var y1 = Cv("Y", lastY); var bulge = Cv("A", 0);
                                rows.Add(new ArcRow(Fr(x1, y1), BulgeM: Math.Min(w, h) > 0 ? bulge / (Math.Min(w, h) / 2) : 0));
                                lastX = x1; lastY = y1;
                                break;
                            }
                            case "NURBSTo":
                            {
                                var x1 = Cv("X", lastX); var y1 = Cv("Y", lastY);
                                var e = row.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == "E")?.Attribute("V")?.Value;
                                var pts = e is null ? null : FlattenNurbs(e, lastX, lastY, x1, y1, Cv("D", 1), Cv("B", 1), Cv("C", 0), w, h);
                                if (pts is null)
                                {
                                    rows.Add(new LineRow(Fr(x1, y1)));
                                    Note("geometry_approximated", "A curve that could not be evaluated was imported as a straight line to its end point.", elementId, sid, "approximated", "info");
                                }
                                else foreach (var (px, py) in pts) rows.Add(new LineRow(Fr(px, py)));
                                lastX = x1; lastY = y1;
                                break;
                            }
                            case "EllipticalArcTo":
                            {
                                var x1 = Cv("X", lastX); var y1 = Cv("Y", lastY);
                                foreach (var (px, py) in FlattenEllipticalArc(lastX, lastY, x1, y1, Cv("A", (lastX + x1) / 2), Cv("B", (lastY + y1) / 2), Cv("C", 0), Cv("D", 1))) rows.Add(new LineRow(Fr(px, py)));
                                lastX = x1; lastY = y1;
                                break;
                            }
                            case "InfiniteLine": break;
                            default:
                                if (row.Elements(V + "Cell").Any(c => (string?)c.Attribute("N") == "X"))
                                {
                                    lastX = Cv("X", lastX); lastY = Cv("Y", lastY); rows.Add(new LineRow(Fr(lastX, lastY)));
                                    Note("geometry_approximated", $"A {t} segment was imported as a straight line.", elementId, sid, "approximated", "info");
                                }
                                break;
                        }
                    }
                    if (rows.Count > 0) result.Add(new GeoSection(rows, noFill));
                }
                return result;
            }

            /// <summary>
            /// Samples a Visio NURBS segment: NURBS(lastKnot, degree, xType, yType, x, y, knot, weight, ...) lists the control points between the segment's start
            /// and end. Types 0 are fractions of the shape's width or height. Knots are taken as a clamped vector; a segment that does not fit that
            /// (wrong knot count, bad numbers) returns null so the caller can draw a straight line instead of following the control polygon.
            /// </summary>
            static List<(double X, double Y)>? FlattenNurbs(string formula, double sx, double sy, double ex, double ey, double firstWeight, double lastWeight, double firstKnot, double w, double h)
            {
                var open = formula.IndexOf('('); var close = formula.LastIndexOf(')');
                if (!formula.StartsWith("NURBS", StringComparison.OrdinalIgnoreCase) || open < 0 || close < open) return null;
                var a = new List<double>();
                foreach (var part in formula[(open + 1)..close].Split(',', StringSplitOptions.TrimEntries))
                {
                    if (!double.TryParse(part, System.Globalization.NumberStyles.Float, Inv, out var v) || !double.IsFinite(v)) return null;
                    a.Add(v);
                }
                if (a.Count < 4 || (a.Count - 4) % 4 != 0) return null;
                var lastKnot = a[0]; var degree = (int)a[1]; var xRel = a[2] == 0; var yRel = a[3] == 0;
                var px = new List<double> { sx }; var py = new List<double> { sy }; var wt = new List<double> { firstWeight }; var interior = new List<double>();
                for (var i = 4; i < a.Count; i += 4)
                {
                    px.Add(xRel ? a[i] * w : a[i]); py.Add(yRel ? a[i + 1] * h : a[i + 1]); wt.Add(a[i + 3]);
                    if (a[i + 2] > firstKnot + 1e-9 && a[i + 2] < lastKnot - 1e-9) interior.Add(a[i + 2]);
                }
                px.Add(ex); py.Add(ey); wt.Add(lastWeight);
                var n = px.Count;
                if (degree < 1 || degree > 8 || n < degree + 1 || n > 64 || lastKnot <= firstKnot || wt.Any(x => x <= 0) || interior.Count != n - degree - 1) return null;
                interior.Sort();
                var knots = new List<double>();
                for (var i = 0; i <= degree; i++) knots.Add(firstKnot);
                knots.AddRange(interior);
                for (var i = 0; i <= degree; i++) knots.Add(lastKnot);

                (double X, double Y) At(double t)
                {
                    var k = degree;
                    while (k < n - 1 && t >= knots[k + 1]) k++;
                    var dx = new double[degree + 1]; var dy = new double[degree + 1]; var dw = new double[degree + 1];
                    for (var j = 0; j <= degree; j++) { var idx = j + k - degree; dw[j] = wt[idx]; dx[j] = px[idx] * dw[j]; dy[j] = py[idx] * dw[j]; }
                    for (var r = 1; r <= degree; r++)
                        for (var j = degree; j >= r; j--)
                        {
                            var left = knots[j + k - degree]; var right = knots[j + 1 + k - r];
                            var alpha = right - left < 1e-12 ? 0 : (t - left) / (right - left);
                            dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j]; dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j]; dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
                        }
                    return (dx[degree] / dw[degree], dy[degree] / dw[degree]);
                }

                var steps = Math.Max(8, 4 * (n - 1));
                var points = new List<(double X, double Y)>();
                for (var i = 1; i < steps; i++) points.Add(At(firstKnot + (lastKnot - firstKnot) * i / steps));
                points.Add((ex, ey));
                return points.All(p => double.IsFinite(p.X) && double.IsFinite(p.Y)) ? points : null;
            }

            /// <summary>
            /// Samples a Visio elliptical arc from (x0,y0) to (x1,y1) through the control point (cx,cy). The ellipse's major axis lies at `angle` and
            /// `ratio` is major over minor; the points are squeezed into a circle, the circle through the three points is walked, and the result is mapped back.
            /// </summary>
            static IEnumerable<(double X, double Y)> FlattenEllipticalArc(double x0, double y0, double x1, double y1, double cx, double cy, double angle, double ratio)
            {
                if (!(ratio > 1e-6) || !double.IsFinite(ratio)) ratio = 1;
                var ca = Math.Cos(angle); var sa = Math.Sin(angle);
                (double X, double Y) To((double X, double Y) p) => (p.X * ca + p.Y * sa, (-p.X * sa + p.Y * ca) * ratio);
                (double X, double Y) From((double X, double Y) p) => (p.X * ca - (p.Y / ratio) * sa, p.X * sa + (p.Y / ratio) * ca);
                var a = To((x0, y0)); var b = To((cx, cy)); var c = To((x1, y1));
                var d = 2 * (a.X * (b.Y - c.Y) + b.X * (c.Y - a.Y) + c.X * (a.Y - b.Y));
                if (Math.Abs(d) < 1e-12) { yield return (x1, y1); yield break; }
                var ux = ((a.X * a.X + a.Y * a.Y) * (b.Y - c.Y) + (b.X * b.X + b.Y * b.Y) * (c.Y - a.Y) + (c.X * c.X + c.Y * c.Y) * (a.Y - b.Y)) / d;
                var uy = ((a.X * a.X + a.Y * a.Y) * (c.X - b.X) + (b.X * b.X + b.Y * b.Y) * (a.X - c.X) + (c.X * c.X + c.Y * c.Y) * (b.X - a.X)) / d;
                var radius = Math.Sqrt((a.X - ux) * (a.X - ux) + (a.Y - uy) * (a.Y - uy));
                var t0 = Math.Atan2(a.Y - uy, a.X - ux); var tb = Math.Atan2(b.Y - uy, b.X - ux); var t1 = Math.Atan2(c.Y - uy, c.X - ux);
                static double Wrap(double v) { while (v < 0) v += 2 * Math.PI; while (v >= 2 * Math.PI) v -= 2 * Math.PI; return v; }
                var ccw = Wrap(tb - t0) < Wrap(t1 - t0); // does counter-clockwise travel from the start pass the control point before reaching the end?
                var sweep = ccw ? Wrap(t1 - t0) : -Wrap(t0 - t1);
                var steps = Math.Max(4, (int)(Math.Abs(sweep) / (Math.PI / 12)));
                for (var i = 1; i < steps; i++) { var t = t0 + sweep * i / steps; yield return From((ux + radius * Math.Cos(t), uy + radius * Math.Sin(t))); }
                yield return (x1, y1);
            }

            /// <summary>Points along the circular arc from (x0,y0) to (x1,y1) whose midpoint lies `bulge` away from the chord (positive: to the right of travel).</summary>
            static IEnumerable<(double X, double Y)> FlattenArc(double x0, double y0, double x1, double y1, double bulge)
            {
                var chord = Math.Sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
                if (chord < 1e-9 || Math.Abs(bulge) < 1e-9) { yield return (x1, y1); yield break; }
                var radius = (chord * chord / 4 + bulge * bulge) / (2 * Math.Abs(bulge));
                var mx = (x0 + x1) / 2; var my = (y0 + y1) / 2;
                var nx = (y1 - y0) / chord; var ny = -(x1 - x0) / chord; // right-hand normal
                var cx = mx - nx * (radius - Math.Abs(bulge)) * Math.Sign(bulge); var cy = my - ny * (radius - Math.Abs(bulge)) * Math.Sign(bulge);
                var a0 = Math.Atan2(y0 - cy, x0 - cx); var a1 = Math.Atan2(y1 - cy, x1 - cx);
                var sweep = a1 - a0;
                if (bulge > 0) { while (sweep > 0) sweep -= 2 * Math.PI; } else { while (sweep < 0) sweep += 2 * Math.PI; }
                var steps = Math.Max(4, (int)(Math.Abs(sweep) / (Math.PI / 12)));
                for (var i = 1; i <= steps; i++) { var a = a0 + sweep * i / steps; yield return (cx + radius * Math.Cos(a), cy + radius * Math.Sin(a)); }
            }

            // ------------------------------------------------------------ ports
            void ReadPorts(XElement s, string sid, Dictionary<string, string> u)
            {
                var rows = s.Elements(V + "Section").Where(x => (string?)x.Attribute("N") == "Connection").Elements(V + "Row").ToList();
                if (rows.Count == 0) return;
                var w = D(Own(s, "Width"), 1); var h = D(Own(s, "Height"), 1);
                var names = new Dictionary<int, string>();
                if (u.TryGetValue("AgentPorts", out var ap)) { try { foreach (var n in JsonNode.Parse(ap)!.AsArray()) names[n!["ix"]!.GetValue<int>()] = n["id"]!.GetValue<string>(); } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }
                var list = new List<(string, double, double)>();
                for (var i = 0; i < rows.Count; i++)
                {
                    double Cv(string n, double fb) => D(rows[i].Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == n)?.Attribute("V")?.Value, fb);
                    var ix = (int)D((string?)rows[i].Attribute("IX"), i);
                    list.Add((names.GetValueOrDefault(ix) ?? $"p{ix}", w > 0 ? Cv("X", 0) / w : 0, h > 0 ? 1 - Cv("Y", 0) / h : 0));
                }
                portsOf[sid] = list;
            }

            // ------------------------------------------------------------ pictures
            void ReadPicture(XElement s, string sid, Dictionary<string, string> u, Xf xf)
            {
                var id = idByShape[sid];
                var rid = (string?)s.Element(V + "ForeignData")?.Element(V + "Rel")?.Attribute(R + "id");
                var part = rels.FirstOrDefault(r => r.Id == rid)?.Target;
                if (part is null || !rd.pkg.Has(part)) { Placeholder(s, sid, u, xf, "a picture whose image is missing from the package"); return; }
                var bytes = rd.pkg.Read(part);
                if (!bytes.IsOk) { Placeholder(s, sid, u, xf, bytes.Error!.Message); return; }
                var mime = Sniff(bytes.Value);
                if (mime is null) { Placeholder(s, sid, u, xf, "a picture in a format that is not supported (only PNG, JPEG, BMP and SVG are)"); return; }
                var mediaSha = BlobStore.HashOf(bytes.Value);
                var intact = u.GetValueOrDefault("ImageOriginalSha256") == mediaSha;
                if (u.ContainsKey("ImageOriginalSha256") && !intact) Note("picture_replaced", "The picture's image was replaced in Visio; the new image is used and the record of the original is ignored.", id, sid, "new image adopted", "info");

                byte[] finalBytes = bytes.Value; var finalMime = mime; string? assetId = null, assetName = null; var tags = new JsonArray(); string? provenance = null;
                if (intact && u.GetValueOrDefault("AgentImageMime") == "image/svg+xml" && u.TryGetValue("SvgSource", out var svgText))
                {
                    var svgBytes = Encoding.UTF8.GetBytes(svgText);
                    if (u.TryGetValue("AgentAssetSha256", out var origSha) && BlobStore.HashOf(svgBytes) == origSha) { finalBytes = svgBytes; finalMime = "image/svg+xml"; }
                    else Note("svg_source_stale", "The stored SVG no longer matches the picture's record; the bitmap is used.", id, sid, "bitmap used", "info");
                }
                var approved = AssetPreparer.ApproveBytes(finalBytes, finalMime);
                if (!approved.IsOk) { Placeholder(s, sid, u, xf, approved.Error!.Message); return; }
                foreach (var n in approved.Value.Notes) Note("image_sanitised", n, id, sid, "sanitised", "info");
                var bytesOut = approved.Value.Bytes;
                var sha = BlobStore.HashOf(bytesOut);
                if (!rd.blobs.ContainsKey(sha)) rd.blobs[sha] = new ImportedBlob(sha, bytesOut, finalMime);
                if (!rd.assetsBySha.TryGetValue(sha, out var asset))
                {
                    if (intact && u.TryGetValue("AgentAssetSha256", out var recorded) && rd.catalogue.TryGetValue(recorded, out var cat))
                    {
                        assetId = cat["id"]?.GetValue<string>(); assetName = cat["name"]?.GetValue<string>(); provenance = cat["provenance"]?.GetValue<string>();
                        if (cat["tags"] is JsonArray ta) foreach (var t in ta) tags.Add(t!.GetValue<string>());
                    }
                    assetName ??= $"picture-{sha[..8]}";
                    assetId = assetId is { Length: > 0 and <= 256 } && !rd.assetsBySha.Values.Any(a => a["id"]!.GetValue<string>() == assetId) ? assetId : $"asset:{assetName}~{sha}";
                    asset = new JsonObject { ["id"] = assetId, ["name"] = Trim(assetName, 256), ["mimeType"] = finalMime, ["sha256"] = sha, ["tags"] = tags, ["provenance"] = provenance ?? "visio-import" };
                    rd.assetsBySha[sha] = asset;
                }

                var img = Base(s, sid, u, "image", xf);
                img["assetId"] = asset["id"]!.GetValue<string>();
                img["fit"] = "stretch"; img["opacity"] = 1; img["preserveAspectRatio"] = false;
                if (intact && u.TryGetValue("AgentFit", out var fit) && u.TryGetValue("AgentFrame", out var frame) && FrameMatches(img, xf, frame, fit, u))
                {
                    var f = frame.Split(',').Select(x => D(x)).ToArray();
                    img["bounds"] = new JsonObject { ["x"] = f[0], ["y"] = f[1], ["width"] = f[2], ["height"] = f[3] };
                    img["fit"] = fit; img["preserveAspectRatio"] = u.GetValueOrDefault("AgentPreserveAspect") != "0";
                }
                else if (intact && u.ContainsKey("AgentFit")) Note("picture_moved", "The picture was moved or resized in Visio, so its fit mode is now stretch.", id, sid, "fit reset", "info");
                if (intact && u.TryGetValue("AgentOpacity", out var op)) img["opacity"] = Math.Clamp(D(op, 1), 0, 1);
                Add(img);
            }

            /// <summary>The picture still sits where the exporter put it (within 0.05 pt), so the recorded frame and fit mode still describe it.</summary>
            bool FrameMatches(JsonObject img, Xf xf, string frame, string fit, Dictionary<string, string> u)
            {
                var f = frame.Split(',').Select(x => D(x, double.NaN)).ToArray();
                if (f.Length != 4 || f.Any(double.IsNaN)) return false;
                var b = (JsonObject)img["bounds"]!;
                double cx = b["x"]!.GetValue<double>() + b["width"]!.GetValue<double>() / 2, cy = b["y"]!.GetValue<double>() + b["height"]!.GetValue<double>() / 2;
                const double tol = 0.05;
                if (fit == "stretch" || u.GetValueOrDefault("AgentPreserveAspect") == "0" || fit == "cover") return Math.Abs(b["x"]!.GetValue<double>() - f[0]) < tol && Math.Abs(b["y"]!.GetValue<double>() - f[1]) < tol && Math.Abs(b["width"]!.GetValue<double>() - f[2]) < tol && Math.Abs(b["height"]!.GetValue<double>() - f[3]) < tol;
                // contain: the shape is the fitted box inside the frame, centred on it
                return Math.Abs(cx - (f[0] + f[2] / 2)) < tol && Math.Abs(cy - (f[1] + f[3] / 2)) < tol && b["width"]!.GetValue<double>() <= f[2] + tol && b["height"]!.GetValue<double>() <= f[3] + tol;
            }

            static string? Sniff(byte[] b)
            {
                if (b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
                if (b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8) return "image/jpeg";
                if (b.Length > 2 && b[0] == 'B' && b[1] == 'M') return "image/bmp";
                var head = Encoding.UTF8.GetString(b, 0, Math.Min(b.Length, 512));
                return head.Contains("<svg", StringComparison.Ordinal) ? "image/svg+xml" : null;
            }

            void Placeholder(XElement s, string sid, Dictionary<string, string> u, Xf xf, string why)
            {
                var id = idByShape[sid];
                Note("unsupported_shape", $"This shape is {why}; it is shown as a marked placeholder.", id, sid, "placeholder rectangle");
                var shape = Base(s, sid, u, "shape", xf);
                shape["geometry"] = new JsonObject { ["preset"] = "rectangle" };
                shape["style"] = new JsonObject { ["fill"] = new JsonObject { ["kind"] = "none" }, ["stroke"] = new JsonObject { ["kind"] = "solid", ["colour"] = "#b45309", ["opacity"] = 1 }, ["strokeWidthPt"] = 1, ["dash"] = "dashed", ["lineCap"] = "butt", ["lineJoin"] = "miter" };
                ((JsonObject)shape["metadata"]!)["visio.unsupported"] = why;
                Add(shape);
            }

            // ------------------------------------------------------------ connectors
            void ReadConnector(XElement s, string sid, Dictionary<string, string> u, Xf xf, List<XElement> connects)
            {
                var id = idByShape[sid];
                var el = Base(s, sid, u, "connector", xf);
                el["rotationDeg"] = 0.0;
                var mine = connects.Where(c => (string?)c.Attribute("FromSheet") == sid).ToList();
                (double X, double Y) drawnFrom = default, drawnTo = default;
                JsonObject End(bool begin)
                {
                    var cx = begin ? "BeginX" : "EndX"; var cy = begin ? "BeginY" : "EndY";
                    var pagePt = PagePt(ToPage(xf.Parent ?? new Xf(0, 0, 0, 0, 0, 0, 0, null), D(Own(s, cx)), D(Own(s, cy))));
                    if (xf.Parent is null) pagePt = PagePt((D(Own(s, cx)), D(Own(s, cy))));
                    if (begin) drawnFrom = pagePt; else drawnTo = pagePt;
                    var c = mine.FirstOrDefault(x => (string?)x.Attribute("FromCell") == cx);
                    var to = (string?)c?.Attribute("ToSheet");
                    if (c is null || to is null || !idByShape.TryGetValue(to, out var targetId) || !elementKnownLater(to))
                    {
                        if (c is not null) Note("glue_target_missing", "A connector end is glued to a shape that was not imported; it is left free.", id, sid, "end left free");
                        return new JsonObject { ["glue"] = "none", ["point"] = new JsonObject { ["x"] = pagePt.X, ["y"] = pagePt.Y } };
                    }
                    var toCell = (string?)c.Attribute("ToCell") ?? ""; var toPart = (int)D((string?)c.Attribute("ToPart"), 0);
                    if (toCell.StartsWith("Connections.X", StringComparison.Ordinal) && int.TryParse(toCell["Connections.X".Length..], out var n))
                    {
                        var ix = n - 1;
                        var ports = portsOf.GetValueOrDefault(to);
                        var portId = ports is not null && ix >= 0 && ix < ports.Count ? ports[ix].Id : null;
                        if (portId is not null) return new JsonObject { ["elementId"] = targetId, ["port"] = portId, ["glue"] = "static" };
                        Note("glue_port_unknown", "A connector is glued to a connection point that could not be found; it is glued to the shape instead.", id, sid, "glue made dynamic");
                    }
                    _ = toPart;
                    return new JsonObject { ["elementId"] = targetId, ["glue"] = "dynamic" };
                }
                el["from"] = End(true); el["to"] = End(false);
                drawnEnds[id] = (drawnFrom, drawnTo);
                var ext = (int)D(Own(s, "ConLineRouteExt"), 0); var style = (int)D(Own(s, "ShapeRouteStyle"), 1);
                el["route"] = ext == 2 ? "curved" : ext == 1 || style == 2 ? "straight" : "orthogonal";
                var way = new JsonArray();
                if (u.TryGetValue("AgentWaypoints", out var wp)) { try { foreach (var n in JsonNode.Parse(wp)!.AsArray()) way.Add(new JsonObject { ["x"] = n!["x"]!.GetValue<double>(), ["y"] = n["y"]!.GetValue<double>() }); } catch (Exception e) when (e is JsonException or InvalidOperationException) { } }
                el["waypoints"] = way;
                var pattern = (int)D(rd.Line(s, "LinePattern"), 1);
                el["style"] = new JsonObject
                {
                    ["colour"] = rd.Colour(rd.Line(s, "LineColor"), "#000000", id, pageId), ["widthPt"] = Math.Max(0, D(rd.Line(s, "LineWeight"), 0.01) * PtPerInch), ["dash"] = DashOf(pattern == 0 ? 1 : pattern),
                    ["startArrow"] = ArrowName(rd.Line(s, "BeginArrow"), id, sid), ["endArrow"] = ArrowName(rd.Line(s, "EndArrow"), id, sid),
                };
                foreach (var (cell, key) in new[] { ("BeginArrowSize", "startArrowSize"), ("EndArrowSize", "endArrowSize") })
                    if (rd.Line(s, cell) is { } sz && ArrowSizeOf((int)D(sz, 2)) is var named && named != "medium") ((JsonObject)el["style"]!)[key] = named;
                var label = ReadText(s, u, id);
                if (label is not null) el["label"] = label;
                if (u.TryGetValue("AgentLabelAnchor", out var la))
                {
                    try { var n = JsonNode.Parse(la)!; el["labelAnchor"] = new JsonObject { ["position"] = Math.Clamp(n["position"]!.GetValue<double>(), 0, 1), ["offsetPt"] = Math.Clamp(n["offsetPt"]!.GetValue<double>(), -2000, 2000) }; }
                    catch (Exception e) when (e is JsonException or InvalidOperationException or NullReferenceException or FormatException) { }
                }
                if (D(Own(s, "ConLineJumpCode"), 0) == 2 && (int)D(Own(s, "ConLineJumpStyle"), 0) <= 1) el["hops"] = "arc"; // always, as an arc (the only style the editor draws)
                el["bounds"] = ConnectorBounds(el);
                connectorEls.Add(el);
                Add(el);
            }

            /// <summary>
            /// A free end that Visio drew on the middle of another connector's line is a T-junction, so it is joined there and follows that line. Only lines whose
            /// drawn path is certain are used: a straight connector, one with its waypoints, or an elbow that is axis-aligned and so cannot bend.
            /// </summary>
            void InferJoins()
            {
                const double Tolerance = 0.75; // pt
                var lines = new Dictionary<string, List<(double X, double Y)>>();
                foreach (var c in connectorEls)
                {
                    var cid = c["id"]!.GetValue<string>();
                    if (!drawnEnds.TryGetValue(cid, out var ends)) continue;
                    var route = c["route"]!.GetValue<string>();
                    var way = c["waypoints"]!.AsArray().Select(w => (w!["x"]!.GetValue<double>(), w["y"]!.GetValue<double>())).ToList();
                    var line = new List<(double X, double Y)> { ends.From }; line.AddRange(way); line.Add(ends.To);
                    var axisAligned = way.Count == 0 && (Math.Abs(ends.From.X - ends.To.X) < 0.01 || Math.Abs(ends.From.Y - ends.To.Y) < 0.01);
                    if (route == "straight" || way.Count > 0 && route != "curved" || route == "orthogonal" && axisAligned) lines[cid] = line;
                }
                if (lines.Count == 0) return;
                var joinedTo = new Dictionary<string, HashSet<string>>();
                foreach (var c in connectorEls) foreach (var key in new[] { "from", "to" }) if (c[key]!["join"]?["connectorId"]?.GetValue<string>() is { } j) { var me = c["id"]!.GetValue<string>(); if (!joinedTo.TryGetValue(me, out var set)) joinedTo[me] = set = []; set.Add(j); }
                bool Loops(string from, string to)
                {
                    var seen = new HashSet<string>();
                    for (var queue = new Queue<string>(new[] { to }); queue.Count > 0;)
                    {
                        var at = queue.Dequeue();
                        if (at == from) return true;
                        if (seen.Add(at) && joinedTo.TryGetValue(at, out var next)) foreach (var n in next) queue.Enqueue(n);
                    }
                    return false;
                }
                foreach (var c in connectorEls)
                {
                    var me = c["id"]!.GetValue<string>();
                    foreach (var key in new[] { "from", "to" })
                    {
                        var ep = (JsonObject)c[key]!;
                        if (ep["glue"]!.GetValue<string>() != "none" || ep["join"] is not null || !drawnEnds.TryGetValue(me, out var mine)) continue;
                        var p = key == "from" ? mine.From : mine.To;
                        string? bestId = null; double bestAt = 0, bestD = Tolerance;
                        foreach (var (otherId, line) in lines)
                        {
                            if (otherId == me) continue;
                            double total = 0; var lens = new double[line.Count - 1];
                            for (var i = 1; i < line.Count; i++) { lens[i - 1] = Math.Sqrt(Math.Pow(line[i].X - line[i - 1].X, 2) + Math.Pow(line[i].Y - line[i - 1].Y, 2)); total += lens[i - 1]; }
                            if (total < 1e-6) continue;
                            double before = 0;
                            for (var i = 1; i < line.Count; i++)
                            {
                                double dx = line[i].X - line[i - 1].X, dy = line[i].Y - line[i - 1].Y, l2 = dx * dx + dy * dy;
                                if (l2 > 1e-9)
                                {
                                    var t = Math.Clamp(((p.X - line[i - 1].X) * dx + (p.Y - line[i - 1].Y) * dy) / l2, 0, 1);
                                    var d = Math.Sqrt(Math.Pow(line[i - 1].X + t * dx - p.X, 2) + Math.Pow(line[i - 1].Y + t * dy - p.Y, 2));
                                    var at = (before + t * lens[i - 1]) / total;
                                    if (d < bestD && at > 0.02 && at < 0.98) { bestD = d; bestId = otherId; bestAt = at; }
                                }
                                before += lens[i - 1];
                            }
                        }
                        if (bestId is null || Loops(me, bestId)) continue;
                        ep["join"] = new JsonObject { ["connectorId"] = bestId, ["position"] = Math.Round(bestAt, 4) };
                        if (!joinedTo.TryGetValue(me, out var set)) joinedTo[me] = set = [];
                        set.Add(bestId);
                        Note("join_inferred", "A connector end that Visio drew on another connector's line is joined to it, so it follows that line.", me, null, "end joined", "info");
                    }
                }
            }

            /// <summary>Branches the editor joined to another connector come back joined, when that connector is still on the page and the join would not loop.</summary>
            void RestoreJoins()
            {
                var resolvedByAgentId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var (sid, u) in userByShape) if (u.GetValueOrDefault("AgentId") is { } aid && idByShape.TryGetValue(sid, out var rid)) resolvedByAgentId[aid] = rid;
                var joinedTo = new Dictionary<string, HashSet<string>>(); // connector id -> the connectors its ends join
                bool Loops(string from, string to)
                {
                    var seen = new HashSet<string>();
                    for (var queue = new Queue<string>(new[] { to }); queue.Count > 0;)
                    {
                        var at = queue.Dequeue();
                        if (at == from) return true;
                        if (seen.Add(at) && joinedTo.TryGetValue(at, out var next)) foreach (var n in next) queue.Enqueue(n);
                    }
                    return false;
                }
                foreach (var (sid, u) in userByShape)
                {
                    if (!idByShape.TryGetValue(sid, out var elId) || !elementById.TryGetValue(elId, out var el) || el["kind"]!.GetValue<string>() != "connector") continue;
                    foreach (var (row, end) in new[] { ("AgentJoinFrom", "from"), ("AgentJoinTo", "to") })
                    {
                        if (!u.TryGetValue(row, out var json)) continue;
                        try
                        {
                            var n = JsonNode.Parse(json)!;
                            var cid = n["connectorId"]!.GetValue<string>();
                            var target = resolvedByAgentId.GetValueOrDefault(cid) ?? cid;
                            var ep = (JsonObject)el[end]!;
                            if (ep["glue"]!.GetValue<string>() != "none" || ep["point"] is null) continue; // the end was reattached to a shape in Visio: that wins
                            if (target == elId || !elementById.TryGetValue(target, out var c) || c["kind"]!.GetValue<string>() != "connector" || Loops(elId, target))
                            {
                                Note("join_connector_missing", "A branch was joined to a connector that is no longer in the file (or would loop); its end stays where it is.", elId, sid, "join dropped", "info");
                                continue;
                            }
                            ep["join"] = new JsonObject { ["connectorId"] = target, ["position"] = Math.Clamp(n["position"]!.GetValue<double>(), 0, 1) };
                            if (!joinedTo.TryGetValue(elId, out var set)) joinedTo[elId] = set = new HashSet<string>();
                            set.Add(target);
                        }
                        catch (Exception e) when (e is JsonException or InvalidOperationException or NullReferenceException or FormatException) { }
                    }
                }
            }

            /// <summary>Shapes and text boxes the editor pinned to a connector come back pinned, when that connector is still on the page.</summary>
            void RestoreAttachments()
            {
                var resolvedByAgentId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var (sid, u) in userByShape) if (u.GetValueOrDefault("AgentId") is { } aid && idByShape.TryGetValue(sid, out var rid)) resolvedByAgentId[aid] = rid;
                foreach (var (sid, u) in userByShape)
                {
                    if (!u.TryGetValue("AgentAttachment", out var json) || !idByShape.TryGetValue(sid, out var elId) || !elementById.TryGetValue(elId, out var el)) continue;
                    if (el["kind"]!.GetValue<string>() is not ("shape" or "text")) continue;
                    try
                    {
                        var n = JsonNode.Parse(json)!;
                        var cid = n["connectorId"]!.GetValue<string>();
                        var target = resolvedByAgentId.GetValueOrDefault(cid) ?? cid;
                        if (!elementById.TryGetValue(target, out var c) || c["kind"]!.GetValue<string>() != "connector") { Note("attachment_connector_missing", "A shape was pinned to a connector that is no longer in the file; it is left where it is.", elId, sid, "attachment dropped", "info"); continue; }
                        el["attachment"] = new JsonObject { ["connectorId"] = target, ["position"] = Math.Clamp(n["position"]!.GetValue<double>(), 0, 1), ["offsetPt"] = Math.Clamp(n["offsetPt"]!.GetValue<double>(), -2000, 2000) };
                    }
                    catch (Exception e) when (e is JsonException or InvalidOperationException or NullReferenceException or FormatException) { }
                }
            }

            bool elementKnownLater(string shapeId) => shapeById.ContainsKey(shapeId) && (string?)shapeById[shapeId].Attribute("Type") != "Guide" && !IsConnector(shapeById[shapeId]);

            string ArrowName(string? v, string id, string sid)
            {
                var code = (int)D(v, 0);
                var a = ArrowOf(code);
                if (a is null) { Note("arrow_approximated", $"Arrow style {code} is not supported and was dropped.", id, sid, "arrow dropped", "info"); return "none"; }
                return a;
            }

            JsonObject ConnectorBounds(JsonObject el)
            {
                var pts = new List<(double X, double Y)>();
                foreach (var key in new[] { "from", "to" })
                {
                    var ep = (JsonObject)el[key]!;
                    if (ep["point"] is JsonObject p) pts.Add((p["x"]!.GetValue<double>(), p["y"]!.GetValue<double>()));
                    else if (ep["elementId"] is JsonNode eid && elementById.TryGetValue(eid.GetValue<string>(), out var t)) { var b = (JsonObject)t["bounds"]!; pts.Add((b["x"]!.GetValue<double>() + b["width"]!.GetValue<double>() / 2, b["y"]!.GetValue<double>() + b["height"]!.GetValue<double>() / 2)); }
                }
                foreach (var w in (JsonArray)el["waypoints"]!) pts.Add((w!["x"]!.GetValue<double>(), w["y"]!.GetValue<double>()));
                if (pts.Count == 0) return new JsonObject { ["x"] = 0.0, ["y"] = 0.0, ["width"] = 0.0, ["height"] = 0.0 };
                var x0 = pts.Min(p => p.X); var y0 = pts.Min(p => p.Y);
                return new JsonObject { ["x"] = x0, ["y"] = y0, ["width"] = pts.Max(p => p.X) - x0, ["height"] = pts.Max(p => p.Y) - y0 };
            }

            // ------------------------------------------------------------ groups
            void ReadGroup(XElement s, string sid, Dictionary<string, string> u, Xf xf, List<XElement> connects)
            {
                var el = Base(s, sid, u, "group", xf);
                el["rotationDeg"] = 0.0;
                el["childIds"] = new JsonArray();
                var childIds = (JsonArray)el["childIds"]!;
                var before = elements.Count;
                elementById[el["id"]!.GetValue<string>()] = el;
                var placeholderIndex = elements.Count;
                elements.Add(el); // keeps the group ahead of its members; its stacking is settled once they are known
                foreach (var c in s.Element(V + "Shapes")?.Elements(V + "Shape") ?? [])
                {
                    var cid = idByShape[(string?)c.Attribute("ID") ?? ""];
                    Walk(c, xf, connects);
                    if (elementById.ContainsKey(cid)) childIds.Add(cid);
                }
                _ = before; _ = placeholderIndex;
                groups.Add((el, s, (u.GetValueOrDefault("AgentConnectorMembers") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries)));
                if (childIds.Count == 0)
                {
                    elements.Remove(el); elementById.Remove(el["id"]!.GetValue<string>()); groups.RemoveAll(g => g.Group == el);
                    Note("empty_group_dropped", "A group with no importable members was dropped.", el["id"]!.GetValue<string>(), sid, "group dropped", "info");
                }
            }

            /// <summary>
            /// R17: a container from a Visio stencil is a group of frame and heading parts. It becomes one container shape: the group's own box,
            /// line and fill, and the heading's text. Its members are separate shapes on the page and are resolved afterwards.
            /// </summary>
            void ReadContainerGroup(XElement s, string sid, Dictionary<string, string> u, Xf xf)
            {
                var id = idByShape[sid];
                var shape = Base(s, sid, u, "shape", xf);
                shape["geometry"] = new JsonObject { ["preset"] = "rectangle" };
                shape["style"] = Style(s, id, u);
                var heading = s.Descendants(V + "Shape").FirstOrDefault(c => userByShape.GetValueOrDefault((string?)c.Attribute("ID") ?? "")?.GetValueOrDefault("msvStructureType") == "Heading");
                var text = heading is not null ? ReadText(heading, userByShape[(string?)heading.Attribute("ID") ?? ""], id) : ReadText(s, u, id);
                if (text is not null) shape["text"] = text;
                Add(shape);
                Note("container_master_simplified", "A Visio container from a stencil was imported as a container frame with its heading text; the stencil's heading style is not kept.", id, sid, "container frame", "info");
            }

            /// <summary>
            /// R17: Visio's container record. A container lists its members (DEPENDSON 1) and a member names its containers (DEPENDSON 4). A file
            /// built by dragging in Visio lists every depth; one built through Visio's API or by the editor lists only direct members. Either way
            /// a member's direct container is the innermost one that claims it. Visio also makes a shape resting on a container's edge a member
            /// (DEPENDSON 7 to 10 beside 4), so a shape can belong to two containers that are not nested; there, ordinary membership wins over
            /// resting on an edge, and the smallest container breaks a remaining tie. A file the editor wrote names each member's container in
            /// User.AgentContainer; while Visio still lists the member there, that choice is kept. Resize (0 none, 1 grow, 2 fit) and margin (inches) map back.
            /// </summary>
            void ResolveContainers()
            {
                var claims = new Dictionary<string, HashSet<string>>(); // member id to the container ids that claim it
                var edges = new Dictionary<string, HashSet<string>>();  // member id to the containers whose edge it rests on
                var order = new Dictionary<string, List<string>>();     // container id to members in the order it lists them
                void Claim(string container, string member)
                {
                    if (container == member) return;
                    if (!claims.TryGetValue(member, out var set)) claims[member] = set = new();
                    set.Add(container);
                    if (!order.TryGetValue(container, out var list)) order[container] = list = new();
                    if (!list.Contains(member)) list.Add(member);
                }
                bool IsContainer(string sid) => userByShape.GetValueOrDefault(sid)?.GetValueOrDefault("msvStructureType") == "Container";
                foreach (var (sid, s) in shapeById)
                {
                    var formula = s.Elements(V + "Cell").FirstOrDefault(c => (string?)c.Attribute("N") == "Relationships")?.Attribute("F")?.Value;
                    if (formula is null || !idByShape.TryGetValue(sid, out var self)) continue;
                    foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(formula, @"DEPENDSON\((\d+)((?:,[^,()]+!SheetRef\(\))*)\)"))
                    {
                        var kind = m.Groups[1].Value;
                        var refs = System.Text.RegularExpressions.Regex.Matches(m.Groups[2].Value, @"Sheet\.(\d+)!").Select(r => r.Groups[1].Value).Where(idByShape.ContainsKey).ToList();
                        if (kind == "1" && IsContainer(sid)) foreach (var r in refs) Claim(self, idByShape[r]);
                        if (kind == "4") foreach (var r in refs) if (IsContainer(r)) Claim(idByShape[r], self);
                        if (kind is "7" or "8" or "9" or "10") foreach (var r in refs) { if (!edges.TryGetValue(self, out var e)) edges[self] = e = new(); e.Add(idByShape[r]); }
                    }
                }
                var groupOf = new Dictionary<string, string>();
                foreach (var (g, _, _) in groups) foreach (var c in (JsonArray)g["childIds"]!) groupOf[c!.GetValue<string>()] = g["id"]!.GetValue<string>();
                var direct = new Dictionary<string, string>();
                double Area(string id) => elementById.TryGetValue(id, out var e) && e["bounds"] is JsonObject b ? b["width"]!.GetValue<double>() * b["height"]!.GetValue<double>() : double.MaxValue;
                var chosenBy = new Dictionary<string, string>(); // member id to the container the editor named for it
                foreach (var (sid, u) in userByShape)
                    if (u.GetValueOrDefault("AgentContainer") is { } named && IdentityMap.IsUuid(named) && idByShape.TryGetValue(sid, out var mid)) chosenBy[mid] = named.ToLowerInvariant();
                foreach (var (member, all) in claims)
                {
                    var claimed = all;
                    // resting on an edge yields to ordinary membership; then the innermost claimant is the one claimed by all the others
                    if (chosenBy.TryGetValue(member, out var chosen) && claimed.Contains(chosen)) claimed = new HashSet<string> { chosen };
                    var held = claimed.Where(c => !(edges.GetValueOrDefault(member)?.Contains(c) ?? false)).ToHashSet();
                    var holders = held.Count > 0 ? held : claimed;
                    var inner = holders.FirstOrDefault(c => holders.All(o => o == c || (claims.TryGetValue(c, out var up) && up.Contains(o))));
                    if (inner is null)
                    {
                        inner = holders.OrderBy(Area).First();
                        Note("container_member_ambiguous", "Visio lists this shape in more than one container that are not nested; the editor keeps one container per element and chose the smallest.", member, null, "smallest container kept", "info");
                    }
                    if (inner is null || !elementById.ContainsKey(member) || !elementById.TryGetValue(inner, out var box) || box["kind"]!.GetValue<string>() != "shape") continue;
                    if (groupOf.GetValueOrDefault(member) != groupOf.GetValueOrDefault(inner))
                    {
                        Note("container_member_skipped", "A Visio container member sits in a different group from its container; the editor keeps a container and its members in the same group, so this membership was not kept.", member, null, "membership dropped", "info");
                        continue;
                    }
                    direct[member] = inner;
                }
                // a file whose containers hold each other in a loop cannot keep it: the loop is broken where it is found
                foreach (var start in direct.Keys.ToList())
                {
                    var seen = new HashSet<string>();
                    for (var at = start; direct.TryGetValue(at, out var up); at = up)
                    {
                        if (seen.Add(at)) continue;
                        direct.Remove(at);
                        Note("container_cycle_dropped", "Visio lists these containers inside each other in a loop; the editor keeps containers nested one way, so this membership was not kept.", at, null, "membership dropped", "info");
                        break;
                    }
                }
                foreach (var (sid, _) in shapeById)
                {
                    if (!IsContainer(sid) || !idByShape.TryGetValue(sid, out var cid) || !elementById.TryGetValue(cid, out var el) || el["kind"]!.GetValue<string>() != "shape") continue;
                    var u = userByShape[sid];
                    var box = new JsonObject { ["memberIds"] = new JsonArray((order.GetValueOrDefault(cid) ?? []).Where(m => direct.GetValueOrDefault(m) == cid).Select(m => (JsonNode)m).ToArray()) };
                    var fit = u.GetValueOrDefault("msvSDContainerResize") switch { "1" => "grow", "2" => "fit", _ => null };
                    if (fit is not null) box["fit"] = fit;
                    var margin = Math.Round(D(u.GetValueOrDefault("msvSDContainerMargin"), 0) * 72, 4);
                    if (margin > 0) box["marginPt"] = Math.Min(margin, 500);
                    el["container"] = box;
                }
            }

            void FinishGroup(JsonObject g)
            {
                var kids = ((JsonArray)g["childIds"]!).Select(n => elementById[n!.GetValue<string>()]).ToList();
                if (kids.Count == 0) return;
                var boxes = new List<(double X0, double Y0, double X1, double Y1)>();
                foreach (var k in kids)
                {
                    var b = (JsonObject)k["bounds"]!;
                    double x = b["x"]!.GetValue<double>(), y = b["y"]!.GetValue<double>(), w = b["width"]!.GetValue<double>(), h = b["height"]!.GetValue<double>();
                    var rot = (k["rotationDeg"]?.GetValue<double>() ?? 0) * Math.PI / 180;
                    if (rot == 0 || k["kind"]!.GetValue<string>() is "connector" or "group") { boxes.Add((x, y, x + w, y + h)); continue; }
                    var cx = x + w / 2; var cy = y + h / 2;
                    var xs = new List<double>(); var ys = new List<double>();
                    foreach (var (px, py) in new[] { (x, y), (x + w, y), (x + w, y + h), (x, y + h) })
                    {
                        var dx = px - cx; var dy = py - cy;
                        xs.Add(cx + dx * Math.Cos(rot) - dy * Math.Sin(rot)); ys.Add(cy + dx * Math.Sin(rot) + dy * Math.Cos(rot));
                    }
                    boxes.Add((xs.Min(), ys.Min(), xs.Max(), ys.Max()));
                }
                g["bounds"] = new JsonObject { ["x"] = boxes.Min(b => b.X0), ["y"] = boxes.Min(b => b.Y0), ["width"] = boxes.Max(b => b.X1) - boxes.Min(b => b.X0), ["height"] = boxes.Max(b => b.Y1) - boxes.Min(b => b.Y0) };
                g["zIndex"] = kids.Max(k => k["zIndex"]!.GetValue<int>());
            }

            void NormalizeStackingLevels()
            {
                int Level(JsonObject e) => e["level"]?.GetValue<int>() ?? 0;
                int Z(JsonObject e) => e["zIndex"]!.GetValue<int>();
                IEnumerable<JsonObject> Leaves(JsonObject group)
                {
                    foreach (var childId in ((JsonArray)group["childIds"]!).Select(n => n!.GetValue<string>()))
                    {
                        var child = elementById[childId];
                        if (child["kind"]!.GetValue<string>() == "group") foreach (var leaf in Leaves(child)) yield return leaf;
                        else yield return child;
                    }
                }

                var leaves = elements.Where(e => e["kind"]!.GetValue<string>() != "group").ToList();
                var inFileOrder = leaves.OrderBy(Z).ToList();
                if (inFileOrder.Zip(inFileOrder.Skip(1)).Any(pair => Level(pair.First) > Level(pair.Second)))
                    Note("level_order_conflict", "The file's drawn order conflicts with saved stacking levels; levels take precedence and the order within each level follows the file.", action: "stacking order resolved", severity: "info");

                if (leaves.Any(e => Level(e) != 0))
                {
                    var ordered = leaves.OrderBy(Level).ThenBy(Z).ToList();
                    for (var i = 0; i < ordered.Count; i++) ordered[i]["zIndex"] = i + 1;
                }
                foreach (var (group, _, _) in groups.AsEnumerable().Reverse())
                {
                    var top = Leaves(group).OrderBy(Level).ThenBy(Z).LastOrDefault();
                    if (top is null) continue;
                    group["zIndex"] = Z(top);
                    if (Level(top) == 0) group.Remove("level"); else group["level"] = Level(top);
                }
            }

            // ------------------------------------------------------------ guides
            void ReadGuide(XElement s, string sid)
            {
                var angle = D(Own(s, "Angle"), 0);
                var vertical = Math.Abs(Math.Abs(Math.Sin(angle)) - 1) < 0.01;
                var pos = vertical ? D(Own(s, "PinX")) * PtPerInch : pageHeightPt - D(Own(s, "PinY")) * PtPerInch;
                guides.Add(new JsonObject { ["id"] = idByShape[sid], ["orientation"] = vertical ? "vertical" : "horizontal", ["positionPt"] = pos });
            }
        }

        bool catalogueSeenAlias(string pageId, string alias, HashSet<string> seen) => seen.Add(alias);
    }
}

static class FracExt
{
    public static Frac With(this Frac f) => f;
}

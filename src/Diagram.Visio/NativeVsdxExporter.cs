using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Host.Core;
using static Diagram.Visio.Vx;

namespace Diagram.Visio;

/// <summary>
/// Writes a document as a native .vsdx by emitting the Visio XML directly (no third-party writer is involved). Every shape is an ordinary,
/// editable Visio shape: its outline is geometry in the shape's own width and height, text is real text, pictures are Visio pictures,
/// connectors are glued to connection points, and groups are Visio groups whose children scale with them. What Visio cannot hold is listed
/// as a diagnostic, never dropped silently.
/// </summary>
public sealed class NativeVsdxExporter : IVsdxExporter
{
    public async Task<Result<ExportResult>> ExportAsync(ExportSnapshot snapshot, IAssetBlobSource blobs, ExportOptions options, CancellationToken ct)
    {
        var doc = snapshot.Document;
        if (snapshot.Projection.DocumentId != snapshot.DocumentId || snapshot.Projection.SessionId != snapshot.SessionId || snapshot.Projection.Revision != snapshot.Revision)
            return Result<ExportResult>.Fail("invalid_request", "the projection sidecar belongs to a different document, session or revision than the snapshot");
        if (doc.Id != snapshot.DocumentId) return Result<ExportResult>.Fail("invalid_request", "the snapshot's document does not match its scope");

        var run = new Run(snapshot, options);
        var loaded = await run.LoadAssets(blobs, ct);
        if (!loaded.IsOk) return Result<ExportResult>.Fail(loaded.Error!);
        return Result<ExportResult>.Ok(run.Build());
    }

    // ===================================================================================================================
    sealed class Run
    {
        readonly ExportSnapshot snap;
        readonly DiagramDocument doc;
        readonly ExportOptions options;
        readonly List<Diagnostic> diag = new();
        readonly Dictionary<string, string> nativeIds = new();
        readonly List<string> faces = new() { "Calibri" };
        readonly Dictionary<string, (byte[] Bytes, string Ext, string Mime, string Sha, int W, int H, string? CompressionType)> media = new(); // by asset sha
        readonly Dictionary<string, string> mediaPart = new(); // sha -> part name
        readonly Dictionary<string, Asset> assetById;
        readonly HashSet<string> skippedImages = new();

        public Run(ExportSnapshot snapshot, ExportOptions options)
        {
            snap = snapshot; doc = snapshot.Document; this.options = options;
            assetById = doc.Assets.ToDictionary(a => a.Id);
        }

        void Warn(string code, string message, string? elementId = null, string? pageId = null, string? action = null, string severity = "warning") =>
            diag.Add(new Diagnostic { Severity = severity, Code = code, Message = message, ElementId = elementId, PageId = pageId, Action = action });

        // ---------------------------------------------------------------- assets
        public async Task<Result<Unit>> LoadAssets(IAssetBlobSource blobs, CancellationToken ct)
        {
            var used = doc.Pages.SelectMany(p => p.Elements).OfType<ImageElement>().Select(i => i.AssetId).Distinct().ToList();
            var n = 0;
            foreach (var id in used)
            {
                if (!assetById.TryGetValue(id, out var asset)) return Result<Unit>.Fail("invalid_request", $"an image uses the unknown asset {id}");
                ReadOnlyMemory<byte> bytes;
                try { bytes = await blobs.ReadAsync(asset.Sha256, ct); }
                catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException or IOException)
                {
                    return Result<Unit>.Fail("not_found", $"the bytes of asset {id} are missing from the store, so the file was not written", details: new System.Text.Json.Nodes.JsonObject { ["assetId"] = id });
                }
                var data = bytes.ToArray();
                if (BlobStore.HashOf(data) != asset.Sha256) return Result<Unit>.Fail("io_error", $"the stored bytes of asset {id} do not match their hash");
                n++;
                if (asset.MimeType == "image/svg+xml")
                {
                    var png = await blobs.RasteriseAsync(asset.Sha256, ct);
                    if (png is null || png.Value.Length == 0)
                    {
                        skippedImages.Add(id); // reported once for each picture that uses it, where the pictures are written
                        continue;
                    }
                    RememberSvg(asset.Sha256, data);
                    var pngBytes = png.Value.ToArray();
                    var dims = RasterHeader.Read("image/png", pngBytes) ?? (1, 1);
                    media[asset.Sha256] = (pngBytes, "png", "image/png", BlobStore.HashOf(pngBytes), dims.Item1, dims.Item2, "PNG");
                }
                else
                {
                    var dims = RasterHeader.Read(asset.MimeType, data);
                    if (dims is null) return Result<Unit>.Fail("invalid_request", $"asset {id} is not a valid {asset.MimeType} image");
                    var (ext, comp) = asset.MimeType switch { "image/png" => ("png", "PNG"), "image/jpeg" => ("jpeg", "JPEG"), _ => ("bmp", (string?)null) };
                    media[asset.Sha256] = (data, ext, asset.MimeType, asset.Sha256, dims.Value.Width, dims.Value.Height, comp);
                }
                mediaPart[asset.Sha256] = $"visio/media/image{n}.{media[asset.Sha256].Ext}";
            }
            foreach (var a in doc.Assets.Where(a => !used.Contains(a.Id)))
                Warn("unused_asset_not_exported", $"The asset {a.Name} is not used by any picture; a Visio file keeps only pictures that are on a page.", severity: "info", action: "catalogue entry dropped");
            return Result<Unit>.Ok(default);
        }

        int Face(string family)
        {
            var i = faces.IndexOf(family);
            if (i >= 0) return i;
            faces.Add(family);
            return faces.Count - 1;
        }

        // ---------------------------------------------------------------- package
        public ExportResult Build()
        {
            var parts = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
            var pageDocs = new List<(string Name, XDocument Page, List<(string RelId, string Target)> Rels)>();
            var pagesXml = new XElement(V + "Pages", new XAttribute(XNamespace.Xmlns + "r", R.NamespaceName), new XAttribute(XNamespace.Xml + "space", "preserve"));
            for (var pi = 0; pi < doc.Pages.Count; pi++)
            {
                var pb = new PageBuilder(this, doc.Pages[pi], pi);
                var (pageEl, content, rels) = pb.Build();
                pagesXml.Add(pageEl);
                pageDocs.Add(($"page{pi + 1}.xml", content, rels));
            }

            parts["[Content_Types].xml"] = Xml(ContentTypes(pageDocs.Count));
            parts["_rels/.rels"] = Xml(PackageRels());
            parts["docProps/core.xml"] = Xml(CoreProps());
            parts["visio/document.xml"] = Xml(DocumentXml());
            parts["visio/_rels/document.xml.rels"] = Xml(RelsDoc([("rId1", "http://schemas.microsoft.com/visio/2010/relationships/pages", "pages/pages.xml"), ("rId2", "http://schemas.microsoft.com/visio/2010/relationships/windows", "windows.xml")]));
            parts["visio/windows.xml"] = Xml(new XDocument(new XElement(V + "Windows", new XAttribute("ClientWidth", "8.5"), new XAttribute("ClientHeight", "11"),
                new XElement(V + "Window", new XAttribute("WindowType", "1"), new XAttribute("WindowState", "0"), new XAttribute("ClientWidth", "8.5"), new XAttribute("ClientHeight", "11")))));
            parts["visio/pages/pages.xml"] = Xml(new XDocument(pagesXml));
            parts["visio/pages/_rels/pages.xml.rels"] = Xml(RelsDoc(pageDocs.Select((p, i) => ($"rId{i + 1}", "http://schemas.microsoft.com/visio/2010/relationships/page", p.Name)).ToList()));
            foreach (var (name, page, rels) in pageDocs)
            {
                parts[$"visio/pages/{name}"] = Xml(page);
                if (rels.Count > 0) parts[$"visio/pages/_rels/{name}.rels"] = Xml(RelsDoc(rels.Select(r => (r.RelId, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", r.Target)).ToList()));
            }
            foreach (var (sha, m) in media) parts[mediaPart[sha]] = m.Bytes;

            using var ms = new MemoryStream();
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            {
                // [Content_Types].xml first, as Open Packaging Conventions readers expect; a fixed timestamp keeps the output reproducible
                foreach (var (name, bytes) in parts.OrderBy(p => p.Key == "[Content_Types].xml" ? 0 : 1).ThenBy(p => p.Key, StringComparer.Ordinal))
                {
                    var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                    entry.LastWriteTime = new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
                    using var s = entry.Open();
                    s.Write(bytes);
                }
            }
            return new ExportResult(ms.ToArray(), diag, nativeIds);
        }

        static byte[] Xml(XDocument d)
        {
            using var ms = new MemoryStream();
            using (var w = XmlWriter.Create(ms, new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = false, OmitXmlDeclaration = false }))
                d.Save(w);
            return ms.ToArray();
        }

        XDocument ContentTypes(int pageCount)
        {
            var t = new XElement(Ct + "Types",
                new XElement(Ct + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
                new XElement(Ct + "Default", new XAttribute("Extension", "xml"), new XAttribute("ContentType", "application/xml")),
                new XElement(Ct + "Default", new XAttribute("Extension", "png"), new XAttribute("ContentType", "image/png")),
                new XElement(Ct + "Default", new XAttribute("Extension", "jpeg"), new XAttribute("ContentType", "image/jpeg")),
                new XElement(Ct + "Default", new XAttribute("Extension", "bmp"), new XAttribute("ContentType", "image/bmp")),
                new XElement(Ct + "Override", new XAttribute("PartName", "/visio/document.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.drawing.main+xml")),
                new XElement(Ct + "Override", new XAttribute("PartName", "/visio/pages/pages.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.pages+xml")),
                new XElement(Ct + "Override", new XAttribute("PartName", "/visio/windows.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.windows+xml")),
                new XElement(Ct + "Override", new XAttribute("PartName", "/docProps/core.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.core-properties+xml")));
            for (var i = 1; i <= pageCount; i++)
                t.Add(new XElement(Ct + "Override", new XAttribute("PartName", $"/visio/pages/page{i}.xml"), new XAttribute("ContentType", "application/vnd.ms-visio.page+xml")));
            return new XDocument(t);
        }

        static XDocument PackageRels() => new(new XElement(Rels + "Relationships",
            new XElement(Rels + "Relationship", new XAttribute("Id", "rId1"), new XAttribute("Type", "http://schemas.microsoft.com/visio/2010/relationships/document"), new XAttribute("Target", "visio/document.xml")),
            new XElement(Rels + "Relationship", new XAttribute("Id", "rId2"), new XAttribute("Type", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"), new XAttribute("Target", "docProps/core.xml"))));

        static XDocument RelsDoc(IReadOnlyList<(string Id, string Type, string Target)> rels) => new(new XElement(Rels + "Relationships",
            rels.Select(r => new XElement(Rels + "Relationship", new XAttribute("Id", r.Id), new XAttribute("Type", r.Type), new XAttribute("Target", r.Target)))));

        XDocument CoreProps()
        {
            XNamespace cp = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties", dc = "http://purl.org/dc/elements/1.1/", dcterms = "http://purl.org/dc/terms/", xsi = "http://www.w3.org/2001/XMLSchema-instance";
            var created = (options.Created ?? new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero)).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ");
            return new XDocument(new XElement(cp + "coreProperties", new XAttribute(XNamespace.Xmlns + "cp", cp.NamespaceName), new XAttribute(XNamespace.Xmlns + "dc", dc.NamespaceName),
                new XAttribute(XNamespace.Xmlns + "dcterms", dcterms.NamespaceName), new XAttribute(XNamespace.Xmlns + "xsi", xsi.NamespaceName),
                new XElement(dc + "title", options.Title ?? doc.Title),
                new XElement(dcterms + "created", new XAttribute(xsi + "type", "dcterms:W3CDTF"), created)));
        }

        XDocument DocumentXml()
        {
            var assetRows = new List<XElement>
            {
                UserRow("AgentDocumentId", doc.Id), UserRow("AgentSchemaVersion", doc.SchemaVersion.ToString(Inv)), UserRow("AgentTitle", doc.Title),
            };
            if (doc.Metadata.Count > 0) assetRows.Add(UserRow("AgentDocumentMetadata", JsonSerializer.Serialize(doc.Metadata)));
            var n = 0;
            foreach (var a in doc.Assets.Where(a => mediaPart.ContainsKey(a.Sha256) || skippedImages.Contains(a.Id)))
                assetRows.Add(UserRow($"AgentAsset{n++}", JsonSerializer.Serialize(new { id = a.Id, name = a.Name, mime = a.MimeType, sha = a.Sha256, tags = a.Tags, provenance = a.Provenance })));
            return new XDocument(new XElement(V + "VisioDocument",
                new XElement(V + "DocumentSettings", new XAttribute("TopPage", "0"), new XAttribute("DefaultTextStyle", "0"), new XAttribute("DefaultLineStyle", "0"), new XAttribute("DefaultFillStyle", "0"), new XAttribute("DefaultGuideStyle", "4"),
                    new XElement(V + "GlueSettings", "9"), new XElement(V + "SnapSettings", "295"), new XElement(V + "SnapExtensions", "34"), new XElement(V + "SnapAngles"), new XElement(V + "DynamicGridEnabled", "1"),
                    new XElement(V + "ProtectStyles", "0"), new XElement(V + "ProtectShapes", "0"), new XElement(V + "ProtectMasters", "0"), new XElement(V + "ProtectBkgnds", "0")),
                new XElement(V + "Colors"),
                new XElement(V + "FaceNames", faces.Select((f, i) => new XElement(V + "FaceName", new XAttribute("ID", i), new XAttribute("Name", f), new XAttribute("UnicodeRanges", "-536859905 -1073732485 9 0"), new XAttribute("CharSets", "1073742335 -65536"), new XAttribute("Panose", "2 15 5 2 2 2 4 3 2 4"), new XAttribute("Flags", "325")))),
                new XElement(V + "StyleSheets",
                    new XElement(V + "StyleSheet", new XAttribute("ID", "0"), new XAttribute("Name", "No Style"), new XAttribute("NameU", "No Style"),
                        CellS("EnableLineProps", "1"), CellS("EnableFillProps", "1"), CellS("EnableTextProps", "1"), CellS("LineWeight", "0.01041666666666667"), CellS("LineColor", "0"), CellS("LinePattern", "1"), CellS("FillForegnd", "1"), CellS("FillPattern", "1")),
                    new XElement(V + "StyleSheet", new XAttribute("ID", "1"), new XAttribute("Name", "Normal"), new XAttribute("NameU", "Normal"), new XAttribute("BasedOn", "0"), new XAttribute("LineStyle", "0"), new XAttribute("FillStyle", "0"), new XAttribute("TextStyle", "0"),
                        CellS("LinePattern", "1"), CellS("LineColor", "#000000"), CellS("FillPattern", "1"), CellS("FillForegnd", "#FFFFFF"))),
                new XElement(V + "DocumentSheet", new XAttribute("LineStyle", "0"), new XAttribute("FillStyle", "0"), new XAttribute("TextStyle", "0"),
                    new XElement(V + "Section", new XAttribute("N", "User"), assetRows))));
        }

        // =================================================================================================================
        sealed class PageBuilder(Run run, Page page, int pageIndex)
        {
            readonly Dictionary<string, Element> byId = page.Elements.ToDictionary(e => Common(e).Id!);
            readonly Dictionary<string, int> shapeIds = new();
            readonly Dictionary<string, List<(string Id, double X, double Y)>> ports = new();
            readonly Dictionary<string, int> layerIndex = new();
            readonly List<(string RelId, string Target)> rels = new();
            readonly List<XElement> connects = new();
            readonly Dictionary<string, string> parentOf = new();
            /// <summary>R17: member id to the container that lists it.</summary>
            readonly Dictionary<string, string> containerOf = new();
            int nextId = 1;
            int nextRel = 1;

            void Warn(string code, string message, string? elementId = null, string? action = null, string severity = "warning") =>
                run.Warn(code, message, elementId, page.Id, action, severity);

            void ReportRoutingPolicy(Element element)
            {
                var id = Common(element).Id;
                var policy = element switch
                {
                    ShapeElement shape => shape.RoutingPolicy,
                    TextElement text => text.RoutingPolicy,
                    ConnectorElement connector => connector.RoutingPolicy,
                    _ => null,
                };
                if ((Common(element).Level ?? 0) != 0)
                    Warn("level_not_native", "Visio has no native stacking level; the AgentLevel user cell preserves this level when the file is reopened in the editor.", id, "AgentLevel", "info");
                void Unsupported(string field) => Warn("ROUTING_POLICY_NOT_NATIVE",
                    $"Visio does not preserve the editor's {field} routing policy; it remains available when the file is reopened in the editor.",
                    id, field, "info");

                if (policy?.Obstacle is not null) Unsupported("routingPolicy.obstacle");
                if (policy?.ClearancePt is not null) Unsupported("routingPolicy.clearancePt");
                if (policy?.Text is not null) Unsupported("routingPolicy.text");
                if (element is ConnectorElement c)
                {
                    if (c.From.Glue == "dynamic" && c.From.PreferredSide is not null) Unsupported("from.preferredSide");
                    if (c.To.Glue == "dynamic" && c.To.PreferredSide is not null) Unsupported("to.preferredSide");
                }
            }

            public (XElement PageEl, XDocument Content, List<(string, string)> Rels) Build()
            {
                for (var i = 0; i < page.Layers.Count; i++) layerIndex[page.Layers[i].Id] = i;
                foreach (var g in page.Elements.OfType<GroupElement>()) foreach (var c in g.ChildIds) parentOf[c] = g.Id;
                foreach (var s in page.Elements.OfType<ShapeElement>()) if (s.Container is { } box) foreach (var m in box.MemberIds) containerOf[m] = s.Id;
                foreach (var element in page.Elements) ReportRoutingPolicy(element);

                // Visio draws in document order, so shapes go out back to front. A group stacks with its topmost member and draws as a block.
                var roots = page.Elements.Where(e => e is ConnectorElement || !parentOf.ContainsKey(Common(e).Id!)).ToList();
                var ordered = Order(roots);
                foreach (var e in Flatten(ordered)) { shapeIds[Common(e).Id!] = nextId++; }
                AssignPorts();
                CheckInterleaving(ordered);

                var shapes = new XElement(V + "Shapes");
                foreach (var g in page.Guides) shapes.Add(GuideShape(g));
                var pageFrame = new Frame(null, new Bounds { X = 0, Y = 0, Width = page.WidthPt, Height = page.HeightPt });
                foreach (var e in ordered) { var x = Emit(e, pageFrame); if (x is not null) shapes.Add(x); }
                var content = new XElement(V + "PageContents", new XAttribute(XNamespace.Xmlns + "r", R.NamespaceName), new XAttribute(XNamespace.Xml + "space", "preserve"), shapes);
                if (connects.Count > 0) content.Add(new XElement(V + "Connects", connects));
                return (PageElement(), new XDocument(content), rels);
            }

            IEnumerable<Element> Flatten(IEnumerable<Element> es) { foreach (var e in es) { yield return e; if (e is GroupElement g) foreach (var c in Flatten(Order(g.ChildIds.Select(i => byId[i]).Where(c => c is not ConnectorElement)))) yield return c; } }

            Element TopLeaf(Element e) => e is GroupElement g
                ? Leaves(g).OrderBy(l => Common(l).Level ?? 0).ThenBy(l => Common(l).Z).LastOrDefault() ?? e
                : e;
            int TopZ(Element e) => Common(TopLeaf(e)).Z;
            int TopLevel(Element e) => Common(TopLeaf(e)).Level ?? 0;

            List<Element> Order(IEnumerable<Element> es) => es.Select((e, i) => (e, i)).OrderBy(t => TopLevel(t.e)).ThenBy(t => TopZ(t.e)).ThenBy(t => t.i).Select(t => t.e).ToList();

            /// <summary>A group is one block in Visio. If other shapes sit between its members in the editor's stacking, say so.</summary>
            void CheckInterleaving(List<Element> ordered)
            {
                foreach (var g in ordered.OfType<GroupElement>())
                {
                    var leaves = Leaves(g).OrderBy(l => Common(l).Level ?? 0).ThenBy(l => Common(l).Z).ToList();
                    var first = leaves[0]; var last = leaves[^1];
                    var between = page.Elements.Where(e => e is not GroupElement && !IsUnder(Common(e).Id!, g.Id)
                        && CompareLevelZ(e, first) > 0 && CompareLevelZ(e, last) < 0).ToList();
                    if (between.Count > 0)
                        Warn("group_stacking_flattened", $"Shapes sit between the members of group {Label(g)} in the editor's stacking order; in Visio the group draws as one block.", g.Id, "group drawn as a block");
                }
            }

            IEnumerable<Element> Leaves(GroupElement g) { foreach (var c in g.ChildIds.Select(i => byId[i])) { if (c is GroupElement cg) foreach (var l in Leaves(cg)) yield return l; else yield return c; } }
            static int CompareLevelZ(Element a, Element b)
            {
                var level = (Common(a).Level ?? 0).CompareTo(Common(b).Level ?? 0);
                return level != 0 ? level : Common(a).Z.CompareTo(Common(b).Z);
            }
            bool IsUnder(string id, string groupId) { for (var p = parentOf.GetValueOrDefault(id); p is not null; p = parentOf.GetValueOrDefault(p)) if (p == groupId) return true; return false; }
            static string Label(Element e) { var c = Common(e); return c.Alias ?? c.Name ?? c.Id![..8]; }

            // ------------------------------------------------------------ connection points
            static readonly Dictionary<string, (double X, double Y)> Standard = new() { ["north"] = (0.5, 0), ["south"] = (0.5, 1), ["west"] = (0, 0.5), ["east"] = (1, 0.5) };

            void AssignPorts()
            {
                foreach (var e in page.Elements.Where(e => e is ShapeElement or TextElement))
                {
                    var id = Common(e).Id!;
                    var list = new List<(string, double, double)>();
                    if (e is ShapeElement s && s.Ports is { } ps) foreach (var p in ps) list.Add((p.Id, p.X, p.Y));
                    ports[id] = list;
                }
                foreach (var c in page.Elements.OfType<ConnectorElement>())
                    foreach (var ep in new[] { c.From, c.To })
                    {
                        if (ep.Glue != "static" || ep.ElementId is null || ep.Port is null || !ports.TryGetValue(ep.ElementId, out var list)) continue;
                        if (list.All(p => p.Id != ep.Port) && Standard.TryGetValue(ep.Port, out var std)) list.Add((ep.Port, std.X, std.Y));
                    }
            }

            (double X, double Y)? PortPoint(string elementId, string port)
            {
                var list = ports.GetValueOrDefault(elementId);
                var p = list?.FirstOrDefault(x => x.Id == port);
                if (p is null || p.Value.Id is null) return null;
                var b = Common(byId[elementId]);
                var dx = (p.Value.X - 0.5) * b.B.Width; var dy = (p.Value.Y - 0.5) * b.B.Height;
                var r = b.Rot * Math.PI / 180;
                var cx = b.B.X + b.B.Width / 2; var cy = b.B.Y + b.B.Height / 2;
                return (cx + dx * Math.Cos(r) - dy * Math.Sin(r), cy + dx * Math.Sin(r) + dy * Math.Cos(r));
            }

            // ------------------------------------------------------------ frames and common cells
            sealed record Frame(string? GroupSheet, Bounds Bounds) { public bool IsPage => GroupSheet is null; }

            double PageY(double yPt) => (page.HeightPt - yPt) / PtPerInch;

            /// <summary>Pin, size, rotation and the cells every shape carries. Inside a group the values are fractions of the group's own size, as Visio writes them.</summary>
            void Frame2(XElement shape, Bounds b, double rotDeg, Frame frame)
            {
                var cx = b.X + b.Width / 2; var cy = b.Y + b.Height / 2;
                if (frame.IsPage)
                {
                    shape.Add(Cell("PinX", cx / PtPerInch), Cell("PinY", PageY(cy)), Cell("Width", b.Width / PtPerInch), Cell("Height", b.Height / PtPerInch));
                }
                else
                {
                    var fb = frame.Bounds; var s = frame.GroupSheet!;
                    var lx = cx - fb.X; var ly = (fb.Y + fb.Height) - cy;
                    string K(double v, double whole) => whole > 0 ? N(v / whole) : "0";
                    shape.Add(Cell("PinX", lx / PtPerInch, $"Sheet.{s}!Width*{K(lx, fb.Width)}"), Cell("PinY", ly / PtPerInch, $"Sheet.{s}!Height*{K(ly, fb.Height)}"),
                        Cell("Width", b.Width / PtPerInch, $"Sheet.{s}!Width*{K(b.Width, fb.Width)}"), Cell("Height", b.Height / PtPerInch, $"Sheet.{s}!Height*{K(b.Height, fb.Height)}"));
                }
                shape.Add(Cell("LocPinX", b.Width / PtPerInch / 2, "Width*0.5"), Cell("LocPinY", b.Height / PtPerInch / 2, "Height*0.5"),
                    Cell("Angle", -rotDeg * Math.PI / 180), Cell("FlipX", 0), Cell("FlipY", 0), Cell("ResizeMode", 0));
            }

            void LayerCell(XElement shape, IReadOnlyList<string> layerIds, string? elementId)
            {
                var idx = layerIds.Select(l => layerIndex.TryGetValue(l, out var i) ? i : -1).Where(i => i >= 0).ToList();
                if (idx.Count > 0) shape.Add(CellS("LayerMember", string.Join(';', idx)));
            }

            XElement NewShape(string id, string type, string name) =>
                new(V + "Shape", new XAttribute("ID", id), new XAttribute("Name", name), new XAttribute("NameU", name), new XAttribute("Type", type), new XAttribute("LineStyle", "0"), new XAttribute("FillStyle", "0"), new XAttribute("TextStyle", "0"));

            string NativeName(Element e) { var c = Common(e); return Sanitise(c.Alias ?? c.Name ?? Kind(e)); }
            static string Sanitise(string s) { var t = new string(s.Where(ch => ch >= 0x20 && ch != '<' && ch != '>' && ch != '&').ToArray()); return t.Length == 0 ? "Shape" : t.Length > 120 ? t[..120] : t; }

            /// <summary>Visio cannot pin a shape to a connector: the shape is written where the line puts it, and the pin travels in a user cell so the editor can restore it.</summary>
            XElement? AttachmentRow(string elementId, Attachment? a)
            {
                if (a is null || !shapeIds.ContainsKey(a.ConnectorId)) return null;
                Warn("attachment_not_native", "Visio has no connector-attached shapes: the shape is placed on the line and will not follow it if the line is rerouted in Visio. Reopened in the editor it follows again.", elementId, "placed on the line", "info");
                return UserRow("AgentAttachment", JsonSerializer.Serialize(new { connectorId = a.ConnectorId, position = a.Position, offsetPt = a.OffsetPt }));
            }

            XElement UserSection(Element e, params XElement[] extra)
            {
                var c = Common(e);
                var rows = new List<XElement> { UserRow("AgentId", c.Id!), UserRow("AgentKind", Kind(e)) };
                if (c.Level is int level && level != 0) rows.Add(UserRow("AgentLevel", level.ToString(Inv)));
                if (c.Alias is not null) rows.Add(UserRow("AgentAlias", c.Alias));
                if (c.Name is not null) rows.Add(UserRow("AgentName", c.Name));
                if (c.Meta.Count > 0) rows.Add(UserRow("AgentMetadata", JsonSerializer.Serialize(c.Meta)));
                if (c.Locked) rows.Add(UserRow("AgentLocked", "1"));
                if (c.Hidden) rows.Add(UserRow("AgentHidden", "1"));
                rows.AddRange(extra);
                return new XElement(V + "Section", new XAttribute("N", "User"), rows);
            }

            /// <summary>Lock cells Visio enforces, and hiding by switching the outline and text off (Visio has no per-shape visibility flag).</summary>
            void Flags(XElement shape, bool locked)
            {
                if (!locked) return;
                foreach (var n in new[] { "LockMoveX", "LockMoveY", "LockWidth", "LockHeight", "LockRotate", "LockDelete" }) shape.Add(Cell(n, 1));
            }

            // ------------------------------------------------------------ emission
            XElement? Emit(Element e, Frame frame)
            {
                XElement? shape = e switch
                {
                    ConnectorElement con => Connector(con),
                    GroupElement g => Group(g, frame),
                    ImageElement img => Image(img, frame),
                    TextElement t => TextShape(t, frame),
                    ShapeElement s => Shape(s, frame),
                    _ => null,
                };
                if (shape is not null) ContainerRelationships(shape, Common(e).Id!);
                return shape;
            }

            /// <summary>
            /// R17: Visio's own container record, as Visio writes it: the container lists its direct members (DEPENDSON 1) and each member names
            /// its container (DEPENDSON 4). A nested container carries both. Checked against Visio 16, which reads a master-less shape marked
            /// User.msvStructureType = "Container" as a container.
            /// </summary>
            void ContainerRelationships(XElement shape, string id)
            {
                var parts = new List<string>();
                if (containerOf.TryGetValue(id, out var holder) && shapeIds.TryGetValue(holder, out var h))
                {
                    parts.Add($"DEPENDSON(4,Sheet.{h}!SheetRef())");
                    // Visio may add a member to further containers it lies in; this names the one the editor chose, for the way back
                    shape.Elements(V + "Section").FirstOrDefault(s => (string?)s.Attribute("N") == "User")?.Add(UserRow("AgentContainer", holder));
                }
                if (byId[id] is ShapeElement { Container: { } box })
                {
                    var refs = box.MemberIds.Where(shapeIds.ContainsKey).Select(m => $"Sheet.{shapeIds[m]}!SheetRef()").ToList();
                    if (refs.Count > 0) parts.Add($"DEPENDSON(1,{string.Join(',', refs)})");
                }
                if (parts.Count > 0) shape.Add(Cell("Relationships", 0, $"SUM({string.Join(',', parts)})"));
            }

            /// <summary>R17: the user cells that make a shape a Visio container, with Visio's resize rule (0 none, 1 grow, 2 fit) and margin in inches.</summary>
            static IEnumerable<XElement> ContainerRows(Container box)
            {
                yield return UserRow("msvStructureType", "Container");
                yield return new XElement(V + "Row", new XAttribute("N", "msvSDContainerResize"),
                    new XElement(V + "Cell", new XAttribute("N", "Value"), new XAttribute("V", box.Fit switch { "grow" => "1", "fit" => "2", _ => "0" })));
                yield return new XElement(V + "Row", new XAttribute("N", "msvSDContainerMargin"),
                    new XElement(V + "Cell", new XAttribute("N", "Value"), new XAttribute("V", N((box.MarginPt ?? 0) / PtPerInch)), new XAttribute("U", "IN")));
            }

            XElement Group(GroupElement g, Frame frame)
            {
                var id = shapeIds[g.Id];
                var shape = NewShape(id.ToString(Inv), "Group", NativeName(g));
                // The group's frame is its derived bounds; it has no outline of its own and no rotation (members carry theirs).
                Frame2(shape, g.Bounds, 0, frame);
                LayerCell(shape, g.LayerIds, g.Id);
                Flags(shape, g.Locked);
                var connectorMembers = g.ChildIds.Where(i => byId[i] is ConnectorElement).ToList();
                var extra = connectorMembers.Count > 0 ? new[] { UserRow("AgentConnectorMembers", string.Join(';', connectorMembers)) } : [];
                shape.Add(UserSection(g, extra));
                run.nativeIds[g.Id] = $"{pageIndex}/{id}";
                var inner = new Frame(id.ToString(Inv), g.Bounds);
                var kids = new XElement(V + "Shapes");
                foreach (var child in Order(g.ChildIds.Select(i => byId[i]).Where(ch => ch is not ConnectorElement)))
                    if (Emit(child, inner) is { } x) kids.Add(x);
                shape.Add(kids);
                return shape;
            }

            static string Fill(Paint p) => p is SolidPaint s ? Colour(s.Colour) : p is LinearGradientPaint g ? Colour(g.Stops[0].Colour) : "#ffffff";

            /// <summary>The stops of a gradient fill, as Visio keeps them: one row per stop with colour, transparency (1 minus opacity) and position.</summary>
            XElement? GradientSection(Paint fill)
            {
                if (fill is not LinearGradientPaint g) return null;
                var sec = new XElement(V + "Section", new XAttribute("N", "FillGradient"));
                for (var i = 0; i < g.Stops.Count; i++)
                    sec.Add(new XElement(V + "Row", new XAttribute("IX", i), CellS("GradientStopColor", Colour(g.Stops[i].Colour)), Cell("GradientStopColorTrans", 1 - g.Stops[i].Opacity), Cell("GradientStopPosition", g.Stops[i].Offset)));
                return sec;
            }

            void FillAndLine(XElement shape, Paint fill, Paint stroke, double strokeWidthPt, string dash, string cap, string join, string? elementId)
            {
                if (fill is SolidPaint f) shape.Add(CellS("FillForegnd", Colour(f.Colour)), Cell("FillForegndTrans", 1 - f.Opacity), Cell("FillPattern", 1));
                else if (fill is LinearGradientPaint g)
                {
                    // the first stop stays as the plain fill colour for anything that does not read gradients; the gradient itself turns on beside it
                    shape.Add(CellS("FillForegnd", Colour(g.Stops[0].Colour)), Cell("FillForegndTrans", 1 - g.Stops[0].Opacity), Cell("FillPattern", 1),
                        Cell("FillGradientEnabled", 1), Cell("FillGradientDir", 0), Cell("FillGradientAngle", g.AngleDeg * Math.PI / 180), Cell("RotateGradientWithShape", 1));
                }
                else shape.Add(Cell("FillPattern", 0));
                if (stroke is SolidPaint s) shape.Add(CellS("LineColor", Colour(s.Colour)), Cell("LineColorTrans", 1 - s.Opacity), Cell("LinePattern", LinePattern(dash)), Cell("LineWeight", strokeWidthPt / PtPerInch));
                else shape.Add(Cell("LinePattern", 0), Cell("LineWeight", strokeWidthPt / PtPerInch));
                shape.Add(Cell("LineCap", cap switch { "round" => 0, "square" => 2, _ => 1 }));
                if (join != "miter") Warn("line_join_not_mapped", "Visio has no line join setting; a miter join is used.", elementId, "join dropped", "info");
            }

            XElement Shape(ShapeElement s, Frame frame)
            {
                var id = shapeIds[s.Id];
                var shape = NewShape(id.ToString(Inv), "Shape", NativeName(s));
                Frame2(shape, s.Bounds, s.RotationDeg, frame);
                FillAndLine(shape, s.Style.Fill, s.Style.Stroke, s.Style.StrokeWidthPt, s.Style.Dash, s.Style.LineCap, s.Style.LineJoin, s.Id);
                var preset = s.Geometry.SvgPath is not null ? "svgPath" : s.Geometry.Preset ?? "rectangle";
                if (preset == "rounded-rectangle") shape.Add(Cell("Rounding", (s.Geometry.CornerRadiusPt ?? 8) / PtPerInch));
                LayerCell(shape, s.LayerIds, s.Id);
                Flags(shape, s.Locked);
                IReadOnlyList<GeoSection> geo;
                if (s.Geometry.SvgPath is { } path)
                {
                    var parsed = GeometryMap.ForSvgPath(path);
                    if (parsed.IsOk) geo = parsed.Value;
                    else { geo = GeometryMap.ForPreset("rectangle"); Warn("svg_path_not_exported", $"The custom outline could not be read ({parsed.Error!.Message}); a rectangle is used.", s.Id, "outline replaced"); preset = "rectangle"; }
                    if (parsed.IsOk && (path.Contains('C', StringComparison.OrdinalIgnoreCase) || path.Contains('Q', StringComparison.OrdinalIgnoreCase))) Warn("curves_flattened", "Curves in the custom outline are drawn as short straight segments in Visio.", s.Id, "curves flattened", "info");
                }
                else
                {
                    geo = GeometryMap.ForPreset(preset);
                    if (GeometryMap.IsApproximated(preset)) Warn("preset_approximated", $"The {preset} outline is an approximation of the editor's shape.", s.Id, "approximated", "info");
                }
                if (s.Hidden) foreach (var g2 in new[] { "NoShow" }) shape.Add(Cell("HideText", 1));
                AddText(shape, s.Text, s.Id, s.Bounds);
                var extra = new List<XElement> { UserRow("AgentPreset", preset), UserRow("AgentGeomSig", GeometryMap.Signature(geo, s.Bounds.Width, s.Bounds.Height)) };
                if (s.Text is { } tb) { extra.Add(UserRow("AgentTextBlock", "1")); if (!tb.Wrap) extra.Add(UserRow("AgentNoWrap", "1")); }
                if (s.Style.Stroke is NonePaint) extra.Add(UserRow("AgentStrokeWidthPt", N(s.Style.StrokeWidthPt)));
                if (s.Geometry.CornerRadiusPt is { } r) extra.Add(UserRow("AgentCornerRadiusPt", N(r)));
                if (s.Geometry.SvgPath is { Length: > 0 and <= 30000 } keep) extra.Add(UserRow("AgentSvgPath", keep));
                if (AttachmentRow(s.Id, s.Attachment) is { } att) extra.Add(att);
                if (s.Container is { } box) extra.AddRange(ContainerRows(box));
                shape.Add(UserSection(s, extra.Concat(PortRows(s.Id)).ToArray()));
                if (GradientSection(s.Style.Fill) is { } gradient) shape.Add(gradient);
                shape.Add(GeometrySections(geo, s.Bounds, s.Hidden));
                if (PortSection(s.Id, s.Bounds) is { } ps) shape.Add(ps);
                run.nativeIds[s.Id] = $"{pageIndex}/{id}";
                return shape;
            }

            XElement TextShape(TextElement t, Frame frame)
            {
                var id = shapeIds[t.Id];
                var shape = NewShape(id.ToString(Inv), "Shape", NativeName(t));
                Frame2(shape, t.Bounds, t.RotationDeg, frame);
                shape.Add(Cell("FillPattern", 0), Cell("LinePattern", 0));
                LayerCell(shape, t.LayerIds, t.Id);
                Flags(shape, t.Locked);
                if (t.Hidden) shape.Add(Cell("HideText", 1));
                AddText(shape, t.Text, t.Id, t.Bounds);
                var geo = GeometryMap.ForPreset("rectangle");
                var extra = new List<XElement> { UserRow("AgentPreset", "text"), UserRow("AgentGeomSig", GeometryMap.Signature(geo)), UserRow("AgentTextBlock", "1") };
                if (!t.Text.Wrap) extra.Add(UserRow("AgentNoWrap", "1"));
                if (AttachmentRow(t.Id, t.Attachment) is { } att) extra.Add(att);
                shape.Add(UserSection(t, extra.ToArray()));
                shape.Add(GeometrySections(geo, t.Bounds, t.Hidden, noFill: true));
                run.nativeIds[t.Id] = $"{pageIndex}/{id}";
                return shape;
            }

            void AddText(XElement shape, TextBlock? t, string elementId, Bounds? box = null)
            {
                if (t is null) return;
                var colour = Colour(t.Colour);
                shape.Add(Cell("VerticalAlign", t.VerticalAlign switch { "top" => 0, "bottom" => 2, _ => 1 }),
                    Cell("TopMargin", (t.InsetsPt?.Top ?? t.PaddingPt) / PtPerInch), Cell("BottomMargin", (t.InsetsPt?.Bottom ?? t.PaddingPt) / PtPerInch),
                    Cell("LeftMargin", (t.InsetsPt?.Left ?? t.PaddingPt) / PtPerInch), Cell("RightMargin", (t.InsetsPt?.Right ?? t.PaddingPt) / PtPerInch));
                if (t.Orientation == "vertical" && box is not null)
                {
                    // the text block is the shape turned a quarter (reads bottom to top): as wide as the shape is tall, pinned at the middle
                    double w = box.Width / PtPerInch, h = box.Height / PtPerInch;
                    shape.Add(Cell("TxtPinX", w / 2), Cell("TxtPinY", h / 2), Cell("TxtLocPinX", h / 2), Cell("TxtLocPinY", w / 2), Cell("TxtWidth", h), Cell("TxtHeight", w), Cell("TxtAngle", Math.PI / 2));
                }
                shape.Add(new XElement(V + "Section", new XAttribute("N", "Character"), new XElement(V + "Row", new XAttribute("IX", "0"),
                    Cell("Font", run.Face(t.FontFamily)), CellS("Color", colour), Cell("Style", (t.Bold ? 1 : 0) | (t.Italic ? 2 : 0) | (t.Underline ? 4 : 0)), Cell("Size", t.FontSizePt / PtPerInch))));
                shape.Add(new XElement(V + "Section", new XAttribute("N", "Paragraph"), new XElement(V + "Row", new XAttribute("IX", "0"),
                    Cell("HorzAlign", t.HorizontalAlign switch { "left" => 0, "right" => 2, _ => 1 }))));
                if (!t.Wrap) Warn("text_wrap_not_mapped", "Visio has no per-shape setting to turn text wrapping off; the text wraps there.", elementId, "wrap setting kept only for the editor", "info");
                if (t.Value.Length > 0) shape.Add(new XElement(V + "Text", new XElement(V + "cp", new XAttribute("IX", "0")), new XElement(V + "pp", new XAttribute("IX", "0")), Clean(t.Value, elementId)));
            }

            string Clean(string text, string elementId)
            {
                var cleaned = new string(text.Where(ch => ch is '\t' or '\n' or '\r' || ch >= 0x20 && !char.IsSurrogate(ch) || char.IsSurrogate(ch)).ToArray());
                if (cleaned.Length != text.Length) Warn("text_characters_removed", "Control characters that XML cannot hold were removed from the text.", elementId, "characters removed");
                return cleaned.Replace("\r\n", "\n");
            }

            // ------------------------------------------------------------ geometry
            XElement[] GeometrySections(IReadOnlyList<GeoSection> sections, Bounds size, bool hidden, bool noFill = false) =>
                sections.Select((s, ix) =>
                {
                    var sec = new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", ix),
                        Cell("NoFill", s.NoFill || noFill ? 1 : 0), Cell("NoLine", 0), Cell("NoShow", hidden ? 1 : 0), Cell("NoSnap", 0), Cell("NoQuickDrag", 0));
                    var n = 1;
                    double wi = size.Width / PtPerInch, hi = size.Height / PtPerInch;
                    foreach (var r in s.Rows)
                    {
                        switch (r)
                        {
                            case MoveRow m: sec.Add(Row("MoveTo", n++, m.At, size)); break;
                            case LineRow l: sec.Add(Row("LineTo", n++, l.To, size)); break;
                            case ArcRow a:
                            {
                                // a native Visio arc: end point plus the distance from the chord to the arc (A), kept in step with the shape's size by formula
                                var row = Row("ArcTo", n++, a.To, size);
                                var bulgeIn = a.Bulge(size.Width, size.Height) / PtPerInch;
                                var terms = new List<string>();
                                if (a.BulgeW != 0) terms.Add($"Width*{N(a.BulgeW)}");
                                if (a.BulgeH != 0) terms.Add($"Height*{N(a.BulgeH)}");
                                if (a.BulgeM != 0) terms.Add($"MIN(Width,Height)*{N(a.BulgeM / 2)}");
                                row.Add(Cell("A", bulgeIn, terms.Count == 0 ? "0" : string.Join("+", terms).Replace("+-", "-")));
                                sec.Add(row);
                                break;
                            }
                            case EllipseRow el:
                                sec.Add(new XElement(V + "Row", new XAttribute("T", "Ellipse"), new XAttribute("IX", n++),
                                    Cell("X", el.Centre.X * wi, $"Width*{N(el.Centre.X)}"), Cell("Y", (1 - el.Centre.Y) * hi, $"Height*{N(1 - el.Centre.Y)}"),
                                    Cell("A", (el.Centre.X + el.Rx) * wi, $"Width*{N(el.Centre.X + el.Rx)}", "DL"), Cell("B", (1 - el.Centre.Y) * hi, $"Height*{N(1 - el.Centre.Y)}", "DL"),
                                    Cell("C", el.Centre.X * wi, $"Width*{N(el.Centre.X)}", "DL"), Cell("D", (1 - el.Centre.Y + el.Ry) * hi, $"Height*{N(1 - el.Centre.Y + el.Ry)}", "DL")));
                                break;
                        }
                    }
                    return sec;
                }).ToArray();

            // placeholders for unit sizes: rows carry fractions as V and Width/Height formulas; the V values are rewritten with real sizes by SizeFix
            XElement Row(string type, int ix, Frac f, Bounds size) =>
                new(V + "Row", new XAttribute("T", type), new XAttribute("IX", ix),
                    Cell("X", f.At(size.Width, size.Height).X / PtPerInch, f.Mx == 0 ? $"Width*{N(f.X)}" : $"Width*{N(f.X)}+MIN(Width,Height)*{N(f.Mx / 2)}"),
                    Cell("Y", (size.Height - f.At(size.Width, size.Height).Y) / PtPerInch, f.My == 0 ? $"Height*{N(1 - f.Y)}" : $"Height*{N(1 - f.Y)}-MIN(Width,Height)*{N(f.My / 2)}"));

            IEnumerable<XElement> PortRows(string id) =>
                ports.TryGetValue(id, out var list) && list.Count > 0
                    ? [UserRow("AgentPorts", JsonSerializer.Serialize(list.Select((p, i) => new { id = p.Id, ix = i, x = p.X, y = p.Y })))]
                    : [];

            XElement? PortSection(string id, Bounds size)
            {
                if (!ports.TryGetValue(id, out var list) || list.Count == 0) return null;
                var sec = new XElement(V + "Section", new XAttribute("N", "Connection"));
                for (var i = 0; i < list.Count; i++)
                {
                    var (_, px, py) = list[i];
                    double dirX = px <= 0.001 ? -1 : px >= 0.999 ? 1 : 0, dirY = py <= 0.001 ? 1 : py >= 0.999 ? -1 : 0;
                    sec.Add(new XElement(V + "Row", new XAttribute("T", "Connection"), new XAttribute("IX", i),
                        Cell("X", px * size.Width / PtPerInch, $"Width*{N(px)}"), Cell("Y", (1 - py) * size.Height / PtPerInch, $"Height*{N(1 - py)}"), Cell("DirX", dirX), Cell("DirY", dirY), Cell("Type", 0), Cell("AutoGen", 0)));
                }
                return sec;
            }

            // ------------------------------------------------------------ pictures
            XElement? Image(ImageElement img, Frame frame)
            {
                if (run.skippedImages.Contains(img.AssetId))
                {
                    Warn("svg_picture_not_exported", $"The SVG picture {run.assetById[img.AssetId].Name} could not be turned into a bitmap, so it is left out of the Visio file.", img.Id, "picture omitted");
                    return null;
                }
                var asset = run.assetById[img.AssetId];
                var m = run.media[asset.Sha256];
                var id = shapeIds[img.Id];
                var shape = NewShape(id.ToString(Inv), "Foreign", NativeName(img));

                // contain keeps the picture's shape inside the frame; cover fills the frame and crops; stretch fills it
                var frameB = img.Bounds;
                var box = frameB;
                double imgW = frameB.Width, imgH = frameB.Height, offX = 0, offY = 0;
                var aspect = m.W > 0 && m.H > 0 ? (double)m.W / m.H : 1;
                if (img.PreserveAspectRatio && img.Fit != "stretch")
                {
                    if (img.Fit == "contain")
                    {
                        var w = Math.Min(frameB.Width, frameB.Height * aspect); var h = w / aspect;
                        box = new Bounds { X = frameB.X + (frameB.Width - w) / 2, Y = frameB.Y + (frameB.Height - h) / 2, Width = w, Height = h };
                        imgW = w; imgH = h;
                    }
                    else // cover
                    {
                        var w = Math.Max(frameB.Width, frameB.Height * aspect); var h = w / aspect;
                        imgW = w; imgH = h; offX = -(w - frameB.Width) / 2; offY = -(h - frameB.Height) / 2;
                    }
                }
                Frame2(shape, box, img.RotationDeg, frame);
                var imgOffsetX = offX / PtPerInch; var imgOffsetY = offY / PtPerInch;
                shape.Add(Cell("ImgOffsetX", imgOffsetX), Cell("ImgOffsetY", imgOffsetY), Cell("ImgWidth", imgW / PtPerInch, img.Fit == "cover" ? null : "Width*1"), Cell("ImgHeight", imgH / PtPerInch, img.Fit == "cover" ? null : "Height*1"));
                LayerCell(shape, img.LayerIds, img.Id);
                Flags(shape, img.Locked);
                if (img.Opacity < 1) Warn("image_opacity_not_mapped", "Picture transparency is not carried into the Visio picture; it is kept for the editor only.", img.Id, "opacity kept in a note", "info");
                var unit = new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", 0), Cell("NoFill", 0), Cell("NoLine", 0), Cell("NoShow", img.Hidden ? 1 : 0), Cell("NoSnap", 0), Cell("NoQuickDrag", 0));
                var pts = new (int, int)[] { (0, 0), (1, 0), (1, 1), (0, 1), (0, 0) };
                for (var i = 0; i < pts.Length; i++)
                    unit.Add(new XElement(V + "Row", new XAttribute("T", i == 0 ? "RelMoveTo" : "RelLineTo"), new XAttribute("IX", i + 1), Cell("X", pts[i].Item1), Cell("Y", pts[i].Item2)));
                shape.Add(unit);
                var extra = new List<XElement>
                {
                    UserRow("AgentAssetId", asset.Id), UserRow("AgentAssetSha256", asset.Sha256), UserRow("AgentImageMime", asset.MimeType), UserRow("AgentFit", img.Fit),
                    UserRow("AgentFrame", $"{N(frameB.X)},{N(frameB.Y)},{N(frameB.Width)},{N(frameB.Height)}"), UserRow("AgentOpacity", N(img.Opacity)),
                    UserRow("AgentPreserveAspect", img.PreserveAspectRatio ? "1" : "0"),
                    UserRow("ImageOriginalSha256", m.Sha), UserRow("ImageMime", m.Mime), UserRow("ImageSource", $"asset:{asset.Sha256}"),
                };
                if (asset.MimeType == "image/svg+xml")
                {
                    var svg = run.SvgSourceOf(asset);
                    if (svg is not null) extra.Add(UserRow("SvgSource", svg));
                    else Warn("svg_source_not_carried", "The original SVG is too large to keep inside the Visio picture; only the bitmap is kept.", img.Id, "original SVG dropped", "info");
                }
                shape.Add(UserSection(img, extra.ToArray()));
                var rid = $"rId{nextRel++}";
                rels.Add((rid, "../" + run.mediaPart[asset.Sha256].Replace("visio/", "")));
                var fd = new XElement(V + "ForeignData", new XAttribute("ForeignType", "Bitmap"));
                if (m.CompressionType is not null) fd.SetAttributeValue("CompressionType", m.CompressionType);
                fd.Add(new XElement(V + "Rel", new XAttribute(R + "id", rid)));
                shape.Add(fd);
                run.nativeIds[img.Id] = $"{pageIndex}/{id}";
                return shape;
            }

            // ------------------------------------------------------------ connectors
            /// <summary>Which way Visio's ArcTo bulge must be signed for the arc to rise to the left of the direction of travel, as the editor draws it.</summary>
            const double HopBulgeSign = -1;

            /// <summary>The routes a hopping connector goes over: every other visible connector except the ones it is joined to or that join it, and any hopper that is on top of it.</summary>
            List<IReadOnlyList<(double X, double Y)>> HoppedRoutes(ConnectorElement self)
            {
                var routes = new List<IReadOnlyList<(double X, double Y)>>();
                foreach (var other in byId.Values.OfType<ConnectorElement>())
                {
                    if (other.Id == self.Id || other.Hidden) continue;
                    if (new[] { self.From, self.To }.Any(ep => ep.Join?.ConnectorId == other.Id) || new[] { other.From, other.To }.Any(ep => ep.Join?.ConnectorId == self.Id)) continue;
                    if (other.Hops == "arc" && other.ZIndex > self.ZIndex) continue; // two hoppers at one crossing: the one on top hops
                    if (run.snap.Projection.Connectors.GetValueOrDefault(other.Id)?.RoutePoints is { Count: > 1 } rp) { routes.Add(rp.Select(p => (p.X, p.Y)).ToList()); continue; }
                    (double X, double Y)? End(Endpoint ep) => ep.Point is { } p ? (p.X, p.Y) : ep.ElementId is not null && byId.ContainsKey(ep.ElementId) ? (Common(byId[ep.ElementId]).B is var b ? (b.X + b.Width / 2, b.Y + b.Height / 2) : null) : null;
                    var route = new List<(double X, double Y)>();
                    if (End(other.From) is { } f) route.Add(f);
                    route.AddRange(other.Waypoints.Select(p => (p.X, p.Y)));
                    if (End(other.To) is { } t) route.Add(t);
                    if (route.Count > 1) routes.Add(route);
                }
                return routes;
            }

            XElement? Connector(ConnectorElement c)
            {
                var id = shapeIds[c.Id];
                var shape = NewShape(id.ToString(Inv), "Shape", NativeName(c));
                var proj = run.snap.Projection.Connectors.GetValueOrDefault(c.Id);

                (double X, double Y) Centre(string elementId) { var b = Common(byId[elementId]).B; return (b.X + b.Width / 2, b.Y + b.Height / 2); }
                (double X, double Y) Anchor(Endpoint ep)
                {
                    if (ep.Glue == "none" || ep.ElementId is null || !byId.ContainsKey(ep.ElementId)) return ep.Point is { } p ? (p.X, p.Y) : (0, 0);
                    if (ep.Glue == "static" && ep.Port is not null && PortPoint(ep.ElementId, ep.Port) is { } pp) return pp;
                    return Centre(ep.ElementId);
                }
                (double X, double Y) End(Endpoint ep, bool first, out int connectTo, out bool dynamicGlue)
                {
                    connectTo = -1; dynamicGlue = false;
                    if (ep.Glue == "none" || ep.ElementId is null || !byId.ContainsKey(ep.ElementId)) return ep.Point is { } p ? (p.X, p.Y) : (0, 0);
                    if (ep.Glue == "static" && ep.Port is not null && PortPoint(ep.ElementId, ep.Port) is { } pp)
                    {
                        connectTo = ports[ep.ElementId].FindIndex(x => x.Id == ep.Port);
                        return pp;
                    }
                    if (ep.Glue == "static") Warn("port_glue_dropped", $"The connector is glued to port '{ep.Port}', which the target shape does not have; it is glued to the shape instead.", c.Id, "glue made dynamic", "warning");
                    dynamicGlue = true;
                    if (proj?.RoutePoints is { Count: > 0 } rp) { var q = first ? rp[0] : rp[^1]; return (q.X, q.Y); }
                    // without a resolved route, a dynamic end sits where the line to the other end leaves the shape, as Visio draws it
                    return Perimeter(byId[ep.ElementId], Anchor(first ? c.To : c.From));
                }
                var b0 = End(c.From, true, out var fromIx, out var fromDyn);
                var e0 = End(c.To, false, out var toIx, out var toDyn);
                if (c.From.Glue != "none" && c.From.ElementId is not null && !shapeIds.ContainsKey(c.From.ElementId)) Warn("glue_target_missing", "A connector end points at an element that is not on the page.", c.Id, "end left free");

                // route: straight is a line between the ends; others follow the editor's resolved route
                var polyline = new List<(double X, double Y)> { b0 };
                if (c.Route != "straight")
                {
                    if (proj?.RoutePoints is { Count: > 1 } rp) { polyline = rp.Select(p => (p.X, p.Y)).ToList(); polyline[0] = b0; polyline[^1] = e0; }
                    else polyline.AddRange(c.Waypoints.Select(p => (p.X, p.Y)));
                }
                if (polyline.Count == 1 || (c.Route != "straight" && polyline[^1] != e0)) polyline.Add(e0);
                if (c.Route == "straight" && c.Waypoints.Count > 0) Warn("waypoints_dropped", "A straight Visio connector has no waypoints; the authored ones are not carried.", c.Id, "waypoints dropped");
                if (c.Route == "curved") Warn("curve_exported_as_polyline", "The curved connector is written as its resolved path; Visio redraws it as a curve when it is next rerouted.", c.Id, "polyline until rerouted", "info");

                double Vy(double y) => PageY(y);
                double bx = b0.X / PtPerInch, by = Vy(b0.Y), ex = e0.X / PtPerInch, ey = Vy(e0.Y);
                var whole = $"Sheet.{{0}}!Connections.X{{1}}";
                shape.Add(Cell("PinX", (bx + ex) / 2, "GUARD((BeginX+EndX)/2)"), Cell("PinY", (by + ey) / 2, "GUARD((BeginY+EndY)/2)"), Cell("Width", ex - bx, "GUARD(EndX-BeginX)"), Cell("Height", ey - by, "GUARD(EndY-BeginY)"),
                    Cell("LocPinX", (ex - bx) / 2, "GUARD(Width*0.5)"), Cell("LocPinY", (ey - by) / 2, "GUARD(Height*0.5)"), Cell("Angle", 0, "GUARD(0)"), Cell("FlipX", 0, "GUARD(FALSE)"), Cell("FlipY", 0, "GUARD(FALSE)"),
                    Cell("ObjType", 2), Cell("ShapeRouteStyle", c.Route == "straight" ? 2 : 1), Cell("ConLineRouteExt", c.Route == "curved" ? 2 : 0));
                // R08c: a route the author steered with waypoints must not be recalculated when Visio moves an attached shape.
                // ConFixedCode 1 keeps the bends where they are and lets only the glued ends follow (measured in Visio; see docs/m5/R08c).
                if (c.Route == "orthogonal" && c.Waypoints.Count > 0) shape.Add(Cell("ConFixedCode", 1));
                void EndCells(bool begin, Endpoint ep, double x, double y, int ix, bool dyn)
                {
                    var (cx, cy) = begin ? ("BeginX", "BeginY") : ("EndX", "EndY");
                    var targetId = ep.ElementId is not null && shapeIds.TryGetValue(ep.ElementId, out var sid) ? sid : -1;
                    if (ix >= 0 && targetId >= 0)
                    {
                        var f = $"PAR(PNT(Sheet.{targetId}!Connections.X{ix + 1},Sheet.{targetId}!Connections.Y{ix + 1}))";
                        shape.Add(Cell(cx, x, f), Cell(cy, y, f));
                        connects.Add(new XElement(V + "Connect", new XAttribute("FromSheet", id), new XAttribute("FromCell", cx), new XAttribute("FromPart", begin ? 9 : 12), new XAttribute("ToSheet", targetId), new XAttribute("ToCell", $"Connections.X{ix + 1}"), new XAttribute("ToPart", 100 + ix)));
                    }
                    else if (dyn && targetId >= 0)
                    {
                        var trig = begin ? "BegTrigger" : "EndTrigger"; var other = begin ? "EndTrigger" : "BegTrigger";
                        var f = $"_WALKGLUE({trig},{other},WalkPreference)";
                        shape.Add(Cell(cx, x, f), Cell(cy, y, f), Cell(trig, 2, $"_XFTRIGGER(Sheet.{targetId}!EventXFMod)"));
                        connects.Add(new XElement(V + "Connect", new XAttribute("FromSheet", id), new XAttribute("FromCell", cx), new XAttribute("FromPart", begin ? 9 : 12), new XAttribute("ToSheet", targetId), new XAttribute("ToCell", "PinX"), new XAttribute("ToPart", 3)));
                    }
                    else shape.Add(Cell(cx, x), Cell(cy, y));
                }
                EndCells(true, c.From, bx, by, fromIx, fromDyn);
                EndCells(false, c.To, ex, ey, toIx, toDyn);
                shape.Add(Cell("LineWeight", c.Style.WidthPt / PtPerInch), CellS("LineColor", Colour(c.Style.Colour)), Cell("LinePattern", LinePattern(c.Style.Dash)), Cell("FillPattern", 0),
                    Cell("BeginArrow", ArrowCode(c.Style.StartArrow)), Cell("EndArrow", ArrowCode(c.Style.EndArrow)),
                    Cell("BeginArrowSize", ArrowSizeCode(c.Style.StartArrowSize)), Cell("EndArrowSize", ArrowSizeCode(c.Style.EndArrowSize)));
                LayerCell(shape, c.LayerIds, c.Id);
                Flags(shape, c.Locked);
                if (c.Label is { } label) { AddText(shape, label, c.Id); }
                var cx = new List<XElement> { UserRow("AgentRoute", c.Route) };
                if (c.LabelAnchor is { } la)
                {
                    cx.Add(UserRow("AgentLabelAnchor", JsonSerializer.Serialize(new { position = la.Position, offsetPt = la.OffsetPt })));
                    if (c.Label is not null && PathMath.PointAt(polyline, la.Position, la.OffsetPt) is { } at)
                    {
                        // the text block's pin, in the connector's own frame (origin at its start, page directions, y up)
                        // a pinned text block needs a size of its own, or Visio wraps it a letter to a line: estimated from the text, centred on the pin
                        var lines = c.Label.Value.Split((char)10);
                        var tw = Math.Max(lines.Max(l => l.Length) * c.Label.FontSizePt * 0.6, 8) + 2 * c.Label.PaddingPt;
                        var th = lines.Length * c.Label.FontSizePt * 1.3 + 2 * c.Label.PaddingPt;
                        shape.Add(Cell("TxtPinX", at.X / PtPerInch - bx), Cell("TxtPinY", Vy(at.Y) - by), Cell("TxtWidth", tw / PtPerInch), Cell("TxtHeight", th / PtPerInch),
                            Cell("TxtLocPinX", tw / PtPerInch / 2), Cell("TxtLocPinY", th / PtPerInch / 2), Cell("TxtAngle", 0));
                        Warn("label_position_fixed", "The label is placed at its position along the line; Visio keeps it there as a fixed offset, so it may drift if the line is rerouted in Visio.", c.Id, "label placed", "info");
                    }
                }
                // R16: Visio cannot glue a connector end to a point along another connector, so a branch is written as an end placed on the line, with the join kept
                // in a user cell so reopening it in the editor joins it again
                foreach (var (name, ep) in new[] { ("AgentJoinFrom", c.From), ("AgentJoinTo", c.To) })
                {
                    if (ep.Join is not { } join) continue;
                    cx.Add(UserRow(name, JsonSerializer.Serialize(new { connectorId = join.ConnectorId, position = join.Position })));
                    Warn("join_not_native", "Visio cannot glue a connector to a point on another connector: the branch ends on the line but will not follow it if the line is moved in Visio. Reopened in the editor it follows again.", c.Id, "end placed on the line", "info");
                }
                // R16: a connector that hops is told to jump always, as an arc; the others are told never to, so Visio's page default does not add jumps the editor does not show
                shape.Add(Cell("ConLineJumpCode", c.Hops == "arc" ? 2 : 1));
                if (c.Hops == "arc") shape.Add(Cell("ConLineJumpStyle", 1));
                if (c.Label is not null) cx.Add(UserRow("AgentTextBlock", "1"));
                if (c.Waypoints.Count > 0) cx.Add(UserRow("AgentWaypoints", JsonSerializer.Serialize(c.Waypoints.Select(w => new { x = w.X, y = w.Y }))));
                shape.Add(UserSection(c, cx.ToArray()));

                var geo = new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", 0), Cell("NoFill", 1), Cell("NoLine", c.Hidden ? 1 : 0), Cell("NoShow", c.Hidden ? 1 : 0), Cell("NoSnap", 0), Cell("NoQuickDrag", 0));
                // R16: Visio only jumps a line when it reroutes it, so the arcs are also drawn into the geometry; the jump cells above keep them when it does
                var hops = c.Hops == "arc" && c.Route != "curved" ? HopMath.Crossings(polyline, HoppedRoutes(c)) : [];
                if (hops.Any(h => h.Count > 0))
                {
                    var ix = 1;
                    XElement Pt(string kind, (double X, double Y) p) => new(V + "Row", new XAttribute("T", kind), new XAttribute("IX", ix++), Cell("X", p.X / PtPerInch - bx), Cell("Y", Vy(p.Y) - by));
                    geo.Add(Pt("MoveTo", polyline[0]));
                    for (var i = 1; i < polyline.Count; i++)
                    {
                        var a = polyline[i - 1]; var b = polyline[i]; var len = Math.Sqrt(Math.Pow(b.X - a.X, 2) + Math.Pow(b.Y - a.Y, 2));
                        double tx = (b.X - a.X) / len, ty = (b.Y - a.Y) / len;
                        foreach (var h in hops[i - 1])
                        {
                            geo.Add(Pt("LineTo", (h.X - tx * HopMath.RadiusPt, h.Y - ty * HopMath.RadiusPt)));
                            var arc = Pt("ArcTo", (h.X + tx * HopMath.RadiusPt, h.Y + ty * HopMath.RadiusPt));
                            arc.Add(Cell("A", HopBulgeSign * HopMath.RadiusPt / PtPerInch)); // a half circle: the bulge is the radius
                            geo.Add(arc);
                        }
                        geo.Add(Pt("LineTo", b));
                    }
                }
                else if (c.Route == "straight")
                {
                    geo.Add(new XElement(V + "Row", new XAttribute("T", "MoveTo"), new XAttribute("IX", 1), Cell("X", 0), Cell("Y", 0)),
                        new XElement(V + "Row", new XAttribute("T", "LineTo"), new XAttribute("IX", 2), Cell("X", ex - bx, "Width"), Cell("Y", ey - by, "Height")));
                }
                else
                {
                    for (var i = 0; i < polyline.Count; i++)
                        geo.Add(new XElement(V + "Row", new XAttribute("T", i == 0 ? "MoveTo" : "LineTo"), new XAttribute("IX", i + 1), Cell("X", polyline[i].X / PtPerInch - bx), Cell("Y", Vy(polyline[i].Y) - by)));
                }
                shape.Add(geo);
                _ = whole;
                run.nativeIds[c.Id] = $"{pageIndex}/{id}";
                return shape;
            }

            /// <summary>Where the line from a shape's centre toward `toward` leaves its outline (a rotated rectangle, or an ellipse).</summary>
            static (double X, double Y) Perimeter(Element target, (double X, double Y) toward)
            {
                var c = Common(target);
                var cx = c.B.X + c.B.Width / 2; var cy = c.B.Y + c.B.Height / 2;
                var r = -c.Rot * Math.PI / 180;
                double dx = toward.X - cx, dy = toward.Y - cy;
                // into the shape's own axes
                var lx = dx * Math.Cos(r) - dy * Math.Sin(r); var ly = dx * Math.Sin(r) + dy * Math.Cos(r);
                if (Math.Abs(lx) < 1e-9 && Math.Abs(ly) < 1e-9) return (cx, cy);
                double hw = c.B.Width / 2, hh = c.B.Height / 2, t;
                if (target is ShapeElement { Geometry.Preset: "ellipse" }) t = 1 / Math.Sqrt(lx * lx / (hw * hw) + ly * ly / (hh * hh));
                else t = Math.Min(Math.Abs(lx) > 1e-9 ? hw / Math.Abs(lx) : double.MaxValue, Math.Abs(ly) > 1e-9 ? hh / Math.Abs(ly) : double.MaxValue);
                var ex = lx * t; var ey = ly * t;
                var back = c.Rot * Math.PI / 180;
                return (cx + ex * Math.Cos(back) - ey * Math.Sin(back), cy + ex * Math.Sin(back) + ey * Math.Cos(back));
            }

            // ------------------------------------------------------------ guides, page sheet
            XElement GuideShape(Guide g)
            {
                var id = nextId++;
                var horizontal = g.Orientation == "horizontal";
                var shape = new XElement(V + "Shape", new XAttribute("ID", id), new XAttribute("Type", "Guide"), new XAttribute("LineStyle", "4"), new XAttribute("FillStyle", "4"), new XAttribute("TextStyle", "4"));
                var len = (horizontal ? page.WidthPt : page.HeightPt) / PtPerInch;
                shape.Add(Cell("PinX", horizontal ? 0 : g.PositionPt / PtPerInch), Cell("PinY", horizontal ? PageY(g.PositionPt) : 0), Cell("Width", len), Cell("Height", 0),
                    Cell("LocPinX", len / 2, "Width*0.5"), Cell("LocPinY", 0, "Height*0.5"), Cell("Angle", horizontal ? 0 : Math.PI / 2), Cell("FlipX", 0), Cell("FlipY", 0), Cell("ResizeMode", 0));
                shape.Add(new XElement(V + "Section", new XAttribute("N", "Geometry"), new XAttribute("IX", 0), Cell("NoFill", 1), Cell("NoLine", 0), Cell("NoShow", 0), Cell("NoSnap", 0), Cell("NoQuickDrag", 0),
                    new XElement(V + "Row", new XAttribute("T", "InfiniteLine"), new XAttribute("IX", 1), Cell("X", 0, "Width*0"), Cell("Y", 0, "Height*0.5"), Cell("A", len, "IF(Width>0,Width,0.039370078740157DL)", "DL"), Cell("B", 0, "Height*0.5", "DL"))));
                shape.Add(new XElement(V + "Section", new XAttribute("N", "User"), UserRow("AgentId", g.Id), UserRow("AgentKind", "guide")));
                return shape;
            }

            XElement PageElement()
            {
                var w = page.WidthPt / PtPerInch; var h = page.HeightPt / PtPerInch;
                var sheet = new XElement(V + "PageSheet", new XAttribute("LineStyle", "0"), new XAttribute("FillStyle", "0"), new XAttribute("TextStyle", "0"),
                    Cell("PageWidth", w, null, "MM"), Cell("PageHeight", h, null, "MM"), Cell("PageScale", 1 / 25.4, null, "MM"), Cell("DrawingScale", 1 / 25.4, null, "MM"),
                    Cell("DrawingSizeType", 0), Cell("DrawingScaleType", 0), Cell("InhibitSnap", 0), Cell("UIVisibility", 0), Cell("DrawingResizeType", 0), Cell("PageShapeSplit", 1),
                    Cell("XGridSpacing", page.Grid.SpacingPt / PtPerInch, null, "MM"), Cell("YGridSpacing", page.Grid.SpacingPt / PtPerInch, null, "MM"));
                var user = new List<XElement> { UserRow("AgentPageId", page.Id), UserRow("AgentGrid", JsonSerializer.Serialize(new { visible = page.Grid.Visible, spacingPt = page.Grid.SpacingPt, snap = page.Grid.Snap })) };
                if (page.Background is SolidPaint bg)
                {
                    user.Add(UserRow("AgentBackground", JsonSerializer.Serialize(new { colour = bg.Colour, opacity = bg.Opacity })));
                    if (!string.Equals(bg.Colour, "#ffffff", StringComparison.OrdinalIgnoreCase) || bg.Opacity < 1)
                        Warn("page_background_not_mapped", "Visio has no page background colour here; the page is white and the colour is kept for the editor.", action: "colour kept in a note", severity: "info");
                }
                else user.Add(UserRow("AgentBackground", "{\"none\":true}"));
                if (page.Layers.Count > 0) user.Add(UserRow("AgentLayers", JsonSerializer.Serialize(page.Layers.Select(l => new { id = l.Id, name = l.Name }))));
                if (page.Guides.Count > 0) user.Add(UserRow("AgentGuides", JsonSerializer.Serialize(page.Guides.Select(g => new { id = g.Id, o = g.Orientation, p = g.PositionPt }))));
                sheet.Add(new XElement(V + "Section", new XAttribute("N", "User"), user));
                var layers = new XElement(V + "Section", new XAttribute("N", "Layer"));
                for (var i = 0; i < page.Layers.Count; i++)
                {
                    var l = page.Layers[i];
                    layers.Add(new XElement(V + "Row", new XAttribute("IX", i), CellS("Name", l.Name),
                        l.ColourOverride is { } col ? CellS("Color", Colour(col)) : Cell("Color", 255), Cell("Status", 0), Cell("Visible", l.Visible ? 1 : 0), Cell("Print", l.Printable ? 1 : 0), Cell("Active", 0), Cell("Lock", l.Locked ? 1 : 0),
                        Cell("Snap", l.Snap ? 1 : 0), Cell("Glue", l.Glue ? 1 : 0), CellS("NameUniv", l.Name), Cell("ColorTrans", 0)));
                }
                if (page.Layers.Count > 0) sheet.Add(layers);
                var pageNode = new XElement(V + "Page", new XAttribute("ID", pageIndex), new XAttribute("Name", page.Name), new XAttribute("NameU", page.Name), new XAttribute("ViewScale", "1"),
                    new XAttribute("ViewCenterX", N(w / 2)), new XAttribute("ViewCenterY", N(h / 2)), sheet, new XElement(V + "Rel", new XAttribute(R + "id", $"rId{pageIndex + 1}")));
                return pageNode;
            }
        }

        string? SvgSourceOf(Asset asset)
        {
            // the original SVG text rides in a string cell; an oversized one is not carried
            return svgSources.TryGetValue(asset.Sha256, out var s) ? s : null;
        }
        readonly Dictionary<string, string> svgSources = new();

        public void RememberSvg(string sha, byte[] bytes) { var t = Encoding.UTF8.GetString(bytes); if (t.Length <= 30_000) svgSources[sha] = t; }
    }
}

static class XExt
{
    public static T Also<T>(this T value, Action<T> f) { f(value); return value; }
}

using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

/// <summary>
/// R17: containers travel to Visio as Visio's own containers (User.msvStructureType = "Container" and the Relationships cell) and come back
/// with the same members, nesting, fit and margin. The cell forms are the ones Visio 16 itself wrote for a master-less container.
/// </summary>
public class ContainerVsdxTests
{
    const int Outer = 1, Inner = 2, A = 3, B = 4;

    /// <summary>Outer holds Inner and B; Inner holds A.</summary>
    static ExportSnapshot Nested() => Doc.Snapshot(Doc.Page(new object[]
    {
        Doc.Shape(Outer, 40, 40, 500, 300, new { container = new { memberIds = new[] { Doc.Id(Inner), Doc.Id(B) }, fit = "grow", marginPt = 12 } }, z: 1),
        Doc.Shape(Inner, 60, 70, 250, 200, new { container = new { memberIds = new[] { Doc.Id(A) }, fit = "fit" } }, z: 2),
        Doc.Shape(A, 100, 120, 100, 60, z: 3),
        Doc.Shape(B, 380, 120, 100, 60, z: 4),
    }));

    static XElement ByAgentId(byte[] package, string id) => Fx.Part(package, "visio/pages/page1.xml").Descendants().Where(e => e.Name.LocalName == "Shape")
        .First(s => s.Descendants().Any(r => r.Name.LocalName == "Cell" && (string?)r.Attribute("V") == id && (string?)r.Parent?.Attribute("N") == "AgentId"));
    static string SheetId(byte[] package, int n) => (string)ByAgentId(package, Doc.Id(n)).Attribute("ID")!;
    static string? Relationships(XElement shape) => shape.Elements().FirstOrDefault(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == "Relationships")?.Attribute("F")?.Value;
    static string? User(XElement shape, string n) => shape.Descendants().FirstOrDefault(r => r.Name.LocalName == "Row" && (string?)r.Attribute("N") == n)?.Elements().First().Attribute("V")?.Value;

    [Fact]
    public void ContainersAreWrittenAsVisioContainersWithDirectMembership()
    {
        var exp = RT.Export(Nested());
        string S(int n) => $"Sheet.{SheetId(exp.Package, n)}!SheetRef()";
        var outer = ByAgentId(exp.Package, Doc.Id(Outer));
        Assert.Equal("Container", User(outer, "msvStructureType"));
        Assert.Equal("1", User(outer, "msvSDContainerResize"));
        Assert.Equal(12.0 / 72, double.Parse(User(outer, "msvSDContainerMargin")!, System.Globalization.CultureInfo.InvariantCulture), 9);
        Assert.Equal($"SUM(DEPENDSON(1,{S(Inner)},{S(B)}))", Relationships(outer));
        var inner = ByAgentId(exp.Package, Doc.Id(Inner));
        Assert.Equal("2", User(inner, "msvSDContainerResize"));
        Assert.Equal($"SUM(DEPENDSON(4,{S(Outer)}),DEPENDSON(1,{S(A)}))", Relationships(inner));
        Assert.Equal($"SUM(DEPENDSON(4,{S(Inner)}))", Relationships(ByAgentId(exp.Package, Doc.Id(A))));
        Assert.Equal($"SUM(DEPENDSON(4,{S(Outer)}))", Relationships(ByAgentId(exp.Package, Doc.Id(B))));
        Assert.DoesNotContain(exp.Diagnostics, d => d.Code.StartsWith("container", StringComparison.Ordinal));
    }

    [Fact]
    public void ContainersRoundTripWithTheirMembersNestingFitAndMargin()
    {
        var (_, back) = RT.Trip(Nested());
        var outer = RT.El(back.Document, Doc.Id(Outer));
        Assert.Equal(new[] { Doc.Id(Inner), Doc.Id(B) }, outer["container"]!["memberIds"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal("grow", outer["container"]!["fit"]!.GetValue<string>());
        Assert.Equal(12.0, outer["container"]!["marginPt"]!.GetValue<double>(), 6);
        var inner = RT.El(back.Document, Doc.Id(Inner));
        Assert.Equal(new[] { Doc.Id(A) }, inner["container"]!["memberIds"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal("fit", inner["container"]!["fit"]!.GetValue<string>());
        Assert.Null(inner["container"]!["marginPt"]);
        Assert.Null(RT.El(back.Document, Doc.Id(A))["container"]);
    }

    [Fact]
    public void AFileThatListsEveryDepthAsVisioDoesWhenDraggingStillGivesDirectMembers()
    {
        var exp = RT.Export(Nested());
        string S(int n) => $"Sheet.{SheetId(exp.Package, n)}!SheetRef()";
        var outerId = SheetId(exp.Package, Outer); var aId = SheetId(exp.Package, A);
        var everyDepth = Fx.Edit(exp.Package, "visio/pages/page1.xml", doc =>
        {
            foreach (var shape in doc.Descendants().Where(e => e.Name.LocalName == "Shape"))
            {
                var cell = shape.Elements().FirstOrDefault(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == "Relationships");
                if ((string?)shape.Attribute("ID") == outerId) cell!.SetAttributeValue("F", $"SUM(DEPENDSON(1,{S(A)},{S(Inner)},{S(B)}))");
                if ((string?)shape.Attribute("ID") == aId) cell!.SetAttributeValue("F", $"SUM(DEPENDSON(4,{S(Inner)},{S(Outer)}))");
            }
        });
        var back = RT.Import(everyDepth);
        Assert.Equal(new[] { Doc.Id(Inner), Doc.Id(B) }, RT.El(back.Document, Doc.Id(Outer))["container"]!["memberIds"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal(new[] { Doc.Id(A) }, RT.El(back.Document, Doc.Id(Inner))["container"]!["memberIds"]!.AsArray().Select(n => n!.GetValue<string>()));
    }

    /// <summary>
    /// Visio adds members of its own accord (a shape lying mostly inside another container, or resting on its edge), so a shape can be listed by
    /// two containers. The container the editor named wins while Visio still lists it; otherwise ordinary membership beats an edge and the
    /// innermost container wins.
    /// </summary>
    [Fact]
    public void AShapeVisioListsInTwoContainersKeepsTheEditorsChoiceThenTheInnermost()
    {
        // B belongs to Outer; Visio also lists it in Inner (as it does for a shape lying mostly inside another container)
        var exp = RT.Export(Nested());
        string S(int n) => $"Sheet.{SheetId(exp.Package, n)}!SheetRef()";
        string innerId = SheetId(exp.Package, Inner), bId = SheetId(exp.Package, B);
        byte[] Listed(bool keepChoice, bool edge) => Fx.Edit(exp.Package, "visio/pages/page1.xml", doc =>
        {
            foreach (var shape in doc.Descendants().Where(e => e.Name.LocalName == "Shape"))
            {
                var cell = shape.Elements().First(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == "Relationships");
                if ((string?)shape.Attribute("ID") == innerId) cell.SetAttributeValue("F", $"SUM(DEPENDSON(4,{S(Outer)}),DEPENDSON(1,{S(A)},{S(B)}))");
                if ((string?)shape.Attribute("ID") != bId) continue;
                cell.SetAttributeValue("F", edge ? $"SUM(DEPENDSON(9,{S(Inner)}),DEPENDSON(4,{S(Outer)},{S(Inner)}))" : $"SUM(DEPENDSON(4,{S(Outer)},{S(Inner)}))");
                if (!keepChoice) shape.Descendants().Where(r => r.Name.LocalName == "Row" && (string?)r.Attribute("N") == "AgentContainer").Remove();
            }
        });
        string HolderOfB(ImportResult r) => RT.All(r.Document).First(e => e["container"]?["memberIds"]?.AsArray().Any(m => m!.GetValue<string>() == Doc.Id(B)) == true)["id"]!.GetValue<string>();
        Assert.Equal(Doc.Id(Outer), HolderOfB(RT.Import(Listed(keepChoice: true, edge: false))));    // the editor's choice, still listed by Visio
        var deeper = RT.Import(Listed(keepChoice: false, edge: false));
        Assert.Equal(Doc.Id(Inner), HolderOfB(deeper));                                                // no choice recorded: Inner sits in Outer, so it is the innermost
        Assert.DoesNotContain(deeper.Diagnostics, d => d.Code == "container_member_ambiguous");
        Assert.Equal(Doc.Id(Outer), HolderOfB(RT.Import(Listed(keepChoice: false, edge: true))));    // resting on Inner's edge yields to Outer
    }

    /// <summary>Two containers that are not nested both list a shape and nothing records a choice: the smaller one keeps it, and a note says so.</summary>
    [Fact]
    public void ATieBetweenContainersThatAreNotNestedGoesToTheSmallerOne()
    {
        var exp = RT.Export(Doc.Snapshot(Doc.Page(new object[]
        {
            Doc.Shape(1, 40, 40, 300, 200, new { container = new { memberIds = new[] { Doc.Id(3) } } }, z: 1),
            Doc.Shape(2, 200, 100, 200, 150, new { container = new { memberIds = Array.Empty<string>() } }, z: 2),
            Doc.Shape(3, 220, 120, 100, 60, z: 3),
        })));
        string S(int n) => $"Sheet.{SheetId(exp.Package, n)}!SheetRef()";
        string smallId = SheetId(exp.Package, 2), shapeId = SheetId(exp.Package, 3);
        var both = Fx.Edit(exp.Package, "visio/pages/page1.xml", doc =>
        {
            foreach (var shape in doc.Descendants().Where(e => e.Name.LocalName == "Shape"))
            {
                if ((string?)shape.Attribute("ID") == smallId) shape.Add(new XElement(shape.Name.Namespace + "Cell", new XAttribute("N", "Relationships"), new XAttribute("V", "0"), new XAttribute("F", $"SUM(DEPENDSON(1,{S(3)}))")));
                if ((string?)shape.Attribute("ID") != shapeId) continue;
                shape.Elements().First(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == "Relationships").SetAttributeValue("F", $"SUM(DEPENDSON(4,{S(1)},{S(2)}))");
                shape.Descendants().Where(r => r.Name.LocalName == "Row" && (string?)r.Attribute("N") == "AgentContainer").Remove();
            }
        });
        var back = RT.Import(both);
        Assert.Equal(new[] { Doc.Id(3) }, RT.El(back.Document, Doc.Id(2))["container"]!["memberIds"]!.AsArray().Select(m => m!.GetValue<string>()));
        Assert.Empty(RT.El(back.Document, Doc.Id(1))["container"]!["memberIds"]!.AsArray());
        Assert.Contains(back.Diagnostics, d => d.Code == "container_member_ambiguous" && d.ElementId == Doc.Id(3));
    }

    /// <summary>A file whose containers claim each other in a loop keeps them nested one way, with a note, rather than failing to load.</summary>
    [Fact]
    public void ContainersThatClaimEachOtherInALoopKeepOneWayWithANote()
    {
        var exp = RT.Export(Nested());
        string S(int n) => $"Sheet.{SheetId(exp.Package, n)}!SheetRef()";
        string outerId = SheetId(exp.Package, Outer), innerId = SheetId(exp.Package, Inner);
        var loop = Fx.Edit(exp.Package, "visio/pages/page1.xml", doc =>
        {
            foreach (var shape in doc.Descendants().Where(e => e.Name.LocalName == "Shape"))
            {
                var cell = shape.Elements().First(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == "Relationships");
                if ((string?)shape.Attribute("ID") == outerId) cell.SetAttributeValue("F", $"SUM(DEPENDSON(4,{S(Inner)}),DEPENDSON(1,{S(Inner)},{S(B)}))");
                if ((string?)shape.Attribute("ID") == innerId) cell.SetAttributeValue("F", $"SUM(DEPENDSON(4,{S(Outer)}),DEPENDSON(1,{S(A)},{S(Outer)}))");
            }
        });
        var back = RT.Import(loop);
        bool Holds(int c, int m) => RT.El(back.Document, Doc.Id(c))["container"]!["memberIds"]!.AsArray().Any(n => n!.GetValue<string>() == Doc.Id(m));
        Assert.True(Holds(Outer, Inner) ^ Holds(Inner, Outer));
        Assert.True(Holds(Inner, A) && Holds(Outer, B));
        Assert.Contains(back.Diagnostics, d => d.Code == "container_cycle_dropped");
    }

    /// <summary>A Visio-saved Microsoft sample whose containers come from Visio's own container stencil (groups of frame and heading parts).</summary>
    [Fact]
    public void ContainersFromVisiosOwnStencilImportAsNestedContainerFrames()
    {
        const string sample = @"C:\Dev\vsdx\app-service-reference-architectures.vsdx";
        if (!File.Exists(sample)) return; // the owner's sample is not part of the repository
        using var s = File.OpenRead(sample);
        var r = new NativeVsdxImporter().Import(s, new ImportOptions());
        Assert.True(r.IsOk, r.Error?.Message);
        var page = RT.All(r.Value.Document).ToList();
        var containers = page.Where(e => e["container"] is not null).ToList();
        Assert.NotEmpty(containers);
        Assert.All(containers, c => Assert.Equal("shape", c["kind"]!.GetValue<string>()));
        var holder = new Dictionary<string, string>();
        foreach (var c in containers) foreach (var m in c["container"]!["memberIds"]!.AsArray()) holder[m!.GetValue<string>()] = c["id"]!.GetValue<string>();
        int Depth(string id) { var d = 0; for (var x = id; holder.TryGetValue(x, out var p); x = p) d++; return d; }
        Assert.True(page.Max(e => Depth(e["id"]!.GetValue<string>())) >= 3, "the sample nests containers three deep");
        Assert.Contains(r.Value.Diagnostics, d => d.Code == "container_master_simplified");
        // the document the importer produced is valid: every member is on the page and belongs to one container
        var ids = page.Select(e => e["id"]!.GetValue<string>()).ToHashSet();
        Assert.All(holder.Keys, m => Assert.Contains(m, ids));
    }
}

/// <summary>R17 in the real Visio application: it reads the exported containers as its own and reports their members.</summary>
public class ContainerVisioAcceptanceTests
{
    [Fact]
    public void VisioReadsTheExportedContainersAndTheirMembers()
    {
        if (!OperatingSystem.IsWindows()) return;
        var type = Type.GetTypeFromProgID("Visio.Application");
        if (type is null) return;
        dynamic visio;
        try { visio = Activator.CreateInstance(type)!; } catch (COMException) { return; }
        var file = Path.Combine(Path.GetTempPath(), $"diagram-visio-{Guid.NewGuid():N}-containers.vsdx");
        var saved = Path.Combine(Path.GetTempPath(), $"diagram-visio-{Guid.NewGuid():N}-containers-saved.vsdx");
        try
        {
            visio.Visible = false; visio.AlertResponse = 7;
            File.WriteAllBytes(file, RT.Export(Doc.Snapshot(Doc.Page(new object[]
            {
                Doc.Shape(1, 40, 40, 500, 300, new { name = "outer", container = new { memberIds = new[] { Doc.Id(2), Doc.Id(4) }, fit = "grow", marginPt = 12 } }, z: 1),
                Doc.Shape(2, 60, 70, 250, 200, new { name = "inner", container = new { memberIds = new[] { Doc.Id(3) } } }, z: 2),
                Doc.Shape(3, 100, 120, 100, 60, new { name = "a" }, z: 3),
                Doc.Shape(4, 380, 120, 100, 60, new { name = "b" }, z: 4),
            }))).Package);
            dynamic doc = visio.Documents.Open(file);
            dynamic page = doc.Pages.Item(1);
            var byName = new Dictionary<string, dynamic>();
            foreach (dynamic shape in page.Shapes) byName[(string)shape.Name] = shape;
            string Names(Array shapes) => string.Join(",", shapes.Cast<int>().Select(i => (string)page.Shapes.ItemFromID(i).Name).Order());
            Assert.Equal("inner,outer", Names((Array)page.GetContainers(0)));                                   // both containers, nested included
            Assert.Equal("b,inner", Names((Array)byName["outer"].ContainerProperties.GetMemberShapes(16)));     // direct members (visContainerFlagsExcludeNested)
            Assert.Equal("a,b,inner", Names((Array)byName["outer"].ContainerProperties.GetMemberShapes(0)));    // Visio follows the nesting down
            Assert.Equal("a", Names((Array)byName["inner"].ContainerProperties.GetMemberShapes(16)));
            Assert.Equal(1, (int)byName["outer"].ContainerProperties.ResizeAsNeeded);                 // grow
            Assert.Equal(12.0 / 72, (double)byName["outer"].ContainerProperties.GetMargin(65), 6);    // inches
            Assert.Equal("inner,outer", Names((Array)byName["a"].MemberOfContainers));                          // every enclosing container

            // saved by Visio itself, the file comes back to the editor with the same containers
            doc.SaveAs(saved); doc.Close();
            var back = RT.Import(File.ReadAllBytes(saved));
            string Members(int n) => string.Join(",", RT.El(back.Document, Doc.Id(n))["container"]?["memberIds"]?.AsArray().Select(m => m!.GetValue<string>()) ?? []);
            Assert.Equal($"{Doc.Id(2)},{Doc.Id(4)}", Members(1));
            Assert.Equal(Doc.Id(3), Members(2));
            Assert.Equal("grow", RT.El(back.Document, Doc.Id(1))["container"]!["fit"]!.GetValue<string>());
        }
        finally { try { visio.Quit(); } catch (COMException) { } File.Delete(file); File.Delete(saved); }
    }
}

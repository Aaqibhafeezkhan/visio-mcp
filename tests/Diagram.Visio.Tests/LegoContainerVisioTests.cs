using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Diagram.Core.Contracts;
using Xunit;

/// <summary>
/// R17 acceptance on the owner's Lego Infrastructure drawing. The editor's reproduction with its frames made into four levels of containers
/// (artifacts/r17-containers/lego-containers.document.json, written by src/web/tests/legoContainers.test.ts) is exported; the structure is
/// checked in the file, then in the real Visio application, then after Visio saves it and the editor reads it back.
/// </summary>
public class LegoContainerVisioTests
{
    static readonly string Fixture = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "r17-containers", "lego-containers.document.json");

    static DiagramDocument Lego() => JsonNode.Parse(File.ReadAllText(Fixture))!.Deserialize<DiagramDocument>(ContractJson.Options)!;

    /// <summary>member id to container id, from the editor's document.</summary>
    static Dictionary<string, string> Holders(DiagramDocument doc) =>
        RT.All(doc).Where(e => e["container"] is not null)
            .SelectMany(c => c["container"]!["memberIds"]!.AsArray().Select(m => (Member: m!.GetValue<string>(), Container: c["id"]!.GetValue<string>())))
            .ToDictionary(x => x.Member, x => x.Container);

    [Fact]
    public void TheLegoContainersSurviveExportAndReimport()
    {
        var doc = Lego();
        var (exported, back) = RT.Trip(Doc.Snapshot(doc));
        // R17_WRITE_LEGO_VSDX=1 refreshes the file kept for the owner's by-hand check in Visio
        if (Environment.GetEnvironmentVariable("R17_WRITE_LEGO_VSDX") is not null) File.WriteAllBytes(Path.ChangeExtension(Fixture, null).Replace(".document", "") + ".vsdx", exported.Package);
        Assert.Equal(Holders(doc), Holders(back.Document));
        Assert.Equal(24, RT.All(back.Document).Count(e => e["container"] is not null));
    }

    [Fact]
    public void VisioReadsTheLegoContainersAndTheyComeBackAfterVisioSavesTheFile()
    {
        if (!OperatingSystem.IsWindows()) return;
        var type = Type.GetTypeFromProgID("Visio.Application");
        if (type is null) return;
        dynamic visio;
        try { visio = Activator.CreateInstance(type)!; } catch (COMException) { return; }
        var file = Path.Combine(Path.GetTempPath(), $"diagram-visio-{Guid.NewGuid():N}-lego.vsdx");
        var saved = Path.Combine(Path.GetTempPath(), $"diagram-visio-{Guid.NewGuid():N}-lego-saved.vsdx");
        try
        {
            visio.Visible = false; visio.AlertResponse = 7;
            var doc = Lego();
            var expected = Holders(doc);
            File.WriteAllBytes(file, RT.Export(Doc.Snapshot(doc)).Package);
            dynamic vdoc = visio.Documents.Open(file);
            dynamic page = vdoc.Pages.Item(1);
            string AgentId(int sheet) => (string)page.Shapes.ItemFromID(sheet).CellsU("User.AgentId").ResultStr(0);
            static string AgentIdOf(dynamic s) { try { return (string)s.CellsU("User.AgentId").ResultStr(0); } catch (COMException) { return ""; } }
            var containers = ((Array)page.GetContainers(0)).Cast<int>().ToList();
            Assert.Equal(24, containers.Count);
            var seen = new HashSet<(string Member, string Container)>();
            foreach (var c in containers)
                foreach (var m in ((Array)page.Shapes.ItemFromID(c).ContainerProperties.GetMemberShapes(16)).Cast<int>()) seen.Add((AgentId(m), AgentId(c))); // direct members
            // every exported membership is Visio's too
            foreach (var (member, container) in expected) Assert.Contains((member, container), seen);
            // Visio adds members of its own accord when it opens the file: a shape resting on a container's edge (a boundary relationship,
            // DEPENDSON 7 to 10) and a shape lying mostly inside a container's frame. Every extra membership it reports is one of those.
            var box = RT.All(doc).ToDictionary(e => e["id"]!.GetValue<string>(), e => e["bounds"]!.AsObject());
            bool MostlyInside(string member, string container)
            {
                JsonObject m = box[member], c = box[container];
                double V(JsonObject o, string k) => o[k]!.GetValue<double>();
                var w = Math.Min(V(m, "x") + V(m, "width"), V(c, "x") + V(c, "width")) - Math.Max(V(m, "x"), V(c, "x"));
                var h = Math.Min(V(m, "y") + V(m, "height"), V(c, "y") + V(c, "height")) - Math.Max(V(m, "y"), V(c, "y"));
                return w > 0 && h > 0 && w * h >= 0.5 * V(m, "width") * V(m, "height");
            }
            var extra = seen.Where(p => expected.GetValueOrDefault(p.Member) != p.Container).ToList();
            foreach (var (member, container) in extra)
            {
                dynamic shape = null!;
                foreach (dynamic s in page.Shapes) if (AgentIdOf(s) == member) { shape = s; break; }
                var formula = (string)shape.CellsU("Relationships").FormulaU;
                Assert.True(System.Text.RegularExpressions.Regex.IsMatch(formula, @"DEPENDSON\((7|8|9|10),") || MostlyInside(member, container), $"{member} in {container}: {formula}");
            }
            vdoc.SaveAs(saved); vdoc.Close();
            // saved by Visio, the editor reads back every exported membership; anything more is a membership Visio itself reported
            var back = Holders(RT.Import(File.ReadAllBytes(saved)).Document);
            foreach (var (member, container) in expected) Assert.Equal(container, back.GetValueOrDefault(member));
            foreach (var (member, container) in back.Where(kv => !expected.ContainsKey(kv.Key))) Assert.Contains((member, container), seen);
            Console.WriteLine($"R17 Lego in Visio: {expected.Count} memberships exported and confirmed; Visio added {extra.Count} of its own ({extra.Count(p => !expected.ContainsKey(p.Member))} for shapes the editor had in no container); {back.Count - expected.Count} kept on re-import.");
        }
        finally { try { visio.Quit(); } catch (COMException) { } File.Delete(file); File.Delete(saved); }
    }
}

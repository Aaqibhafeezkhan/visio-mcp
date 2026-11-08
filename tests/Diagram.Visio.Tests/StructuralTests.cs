using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Diagram.Core.Contracts;
using Diagram.Visio;
using Xunit;

public class StructuralTests
{
    static XElement ShapeByAgentId(byte[] package, string id, int page = 1)
    {
        var doc = Fx.Part(package, $"visio/pages/page{page}.xml");
        return doc.Descendants().Where(e => e.Name.LocalName == "Shape").First(s => s.Descendants().Any(r => r.Name.LocalName == "Cell" && (string?)r.Attribute("V") == id && (string?)r.Parent?.Attribute("N") == "AgentId"));
    }
    static string? Cell(XElement shape, string n) => shape.Elements().FirstOrDefault(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == n)?.Attribute("V")?.Value;
    static string? UserValue(XElement shape, string n) => shape.Descendants().FirstOrDefault(r => r.Name.LocalName == "Row" && (string?)r.Attribute("N") == n)?.Elements().FirstOrDefault(c => c.Name.LocalName == "Cell")?.Attribute("V")?.Value;
    static string? CellF(XElement shape, string n) => shape.Elements().FirstOrDefault(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == n)?.Attribute("F")?.Value;
    static void Near(double expected, double? actual, double tol = 0.01) => Assert.True(actual is { } a && Math.Abs(a - expected) <= tol, $"expected {expected} but was {actual}");

    // ---------------------------------------------------------------- connectors

    [Fact]
    public void StaticDynamicAndFreeEndsAreMappedAndComeBack()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 60, 80, 120, 60, new { alias = "a", ports = new[] { new { id = "out", x = 1.0, y = 0.5 } } }),
            Doc.Shape(2, 300, 80, 120, 60, new { alias = "b", rotationDeg = 90, ports = new[] { new { id = "in", x = 0.0, y = 0.5 } } }),
            Doc.Connector(10, Doc.Glue(1, "static", "out"), Doc.Glue(2, "static", "in")),
            Doc.Connector(11, Doc.Glue(1), Doc.Glue(2)),
            Doc.Connector(12, Doc.Free(60, 300), Doc.Free(260.5, 340.25)),
            Doc.Connector(13, Doc.Glue(1), Doc.Free(500, 400)),
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));

        // static: glued to connection point 1 (ToPart 100), with the begin/end driven by that point
        var page = Fx.Part(exp.Package, "visio/pages/page1.xml");
        var connects = page.Descendants().Where(e => e.Name.LocalName == "Connect").ToList();
        Assert.Equal(2 + 2 + 0 + 1, connects.Count);
        var staticConn = ShapeByAgentId(exp.Package, Doc.Id(10));
        Assert.Contains("Connections.X1", CellF(staticConn, "BeginX"));
        Assert.Contains(connects, c => (string?)c.Attribute("FromSheet") == (string?)staticConn.Attribute("ID") && (string?)c.Attribute("ToPart") == "100" && (string?)c.Attribute("FromPart") == "9");
        // dynamic: glued to the whole shape (ToPart 3)
        var dyn = ShapeByAgentId(exp.Package, Doc.Id(11));
        Assert.Contains("_WALKGLUE", CellF(dyn, "BeginX"));
        Assert.Contains(connects, c => (string?)c.Attribute("FromSheet") == (string?)dyn.Attribute("ID") && (string?)c.Attribute("ToPart") == "3");
        // free: no connect at all
        var free = ShapeByAgentId(exp.Package, Doc.Id(12));
        Assert.DoesNotContain(connects, c => (string?)c.Attribute("FromSheet") == (string?)free.Attribute("ID"));

        var doc = back.Document;
        var s = RT.El(doc, Doc.Id(10));
        Assert.Equal("static", s["from"]!["glue"]!.GetValue<string>());
        Assert.Equal("out", s["from"]!["port"]!.GetValue<string>());
        Assert.Equal(Doc.Id(1), s["from"]!["elementId"]!.GetValue<string>());
        Assert.Equal("in", s["to"]!["port"]!.GetValue<string>());
        var d = RT.El(doc, Doc.Id(11));
        Assert.Equal("dynamic", d["from"]!["glue"]!.GetValue<string>());
        Assert.Null(d["from"]!["port"]);
        var f = RT.El(doc, Doc.Id(12));
        Assert.Equal("none", f["from"]!["glue"]!.GetValue<string>());
        Near(60, f["from"]!["point"]!["x"]!.GetValue<double>()); Near(300, f["from"]!["point"]!["y"]!.GetValue<double>());
        Near(260.5, f["to"]!["point"]!["x"]!.GetValue<double>()); Near(340.25, f["to"]!["point"]!["y"]!.GetValue<double>());
        var mixed = RT.El(doc, Doc.Id(13));
        Assert.Equal("dynamic", mixed["from"]!["glue"]!.GetValue<string>());
        Assert.Equal("none", mixed["to"]!["glue"]!.GetValue<string>());
    }

    [Fact]
    public void ConnectorEndsLandOnTheShapesWithRotationApplied()
    {
        // the port is on the right edge of a shape turned a quarter: it must sit on the bottom of the turned shape
        var shapes = new object[]
        {
            Doc.Shape(1, 200, 100, 100, 40, new { rotationDeg = 90, ports = new[] { new { id = "east", x = 1.0, y = 0.5 } } }),
            Doc.Shape(2, 400, 300, 60, 40),
            Doc.Connector(10, Doc.Glue(1, "static", "east"), Doc.Free(300, 300)),
        };
        var exp = RT.Export(Doc.Snapshot(Doc.Page(shapes)));
        var c = ShapeByAgentId(exp.Package, Doc.Id(10));
        // centre (250,120); right-hand port is 50 pt from centre, turned clockwise 90 degrees: (250, 170)
        var page = Fx.Part(exp.Package, "visio/pages/pages.xml");
        _ = page;
        var beginX = double.Parse(Cell(c, "BeginX")!, System.Globalization.CultureInfo.InvariantCulture) * 72;
        var beginY = 595.2755905511812 - double.Parse(Cell(c, "BeginY")!, System.Globalization.CultureInfo.InvariantCulture) * 72;
        Near(250, beginX, 1e-6); Near(170, beginY, 1e-6);
    }

    [Theory]
    [InlineData("straight")] [InlineData("orthogonal")] [InlineData("curved")]
    public void RoutesAndAuthoredWaypointsSurvive(string route)
    {
        var waypoints = route == "straight" ? Array.Empty<object>() : [new { x = 250.0, y = 200.0 }, new { x = 250.0, y = 260.0 }];
        var shapes = new object[]
        {
            Doc.Shape(1, 60, 80, 100, 50), Doc.Shape(2, 400, 300, 100, 50),
            Doc.Connector(10, Doc.Glue(1), Doc.Glue(2), route, new { waypoints }),
        };
        var routes = new Dictionary<string, JsonObject> { [Doc.Id(10)] = Doc.Route((160, 105), (250, 105), (250, 325), (400, 325)) };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Make([Doc.Page(shapes)]), routes));
        var c = RT.El(back.Document, Doc.Id(10));
        Assert.Equal(route, c["route"]!.GetValue<string>());
        Assert.Equal(waypoints.Length, c["waypoints"]!.AsArray().Count);
        if (waypoints.Length > 0) { Near(250, c["waypoints"]![0]!["x"]!.GetValue<double>()); Near(260, c["waypoints"]![1]!["y"]!.GetValue<double>()); }
        // a non-straight connector is written along the route the editor resolved, so Visio shows the same path until it reroutes
        var shape = ShapeByAgentId(exp.Package, Doc.Id(10));
        var rows = shape.Descendants().Where(e => e.Name.LocalName == "Row" && ((string?)e.Attribute("T") is "MoveTo" or "LineTo")).Count();
        Assert.Equal(route == "straight" ? 2 : 4, rows);
        if (route == "curved") Assert.Contains(exp.Diagnostics, d => d.Code == "curve_exported_as_polyline" && d.Severity == "info");
    }

    [Fact]
    public void UnsupportedRoutingPolicyIsReportedWhileGeometryRemainsEditable()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 60, 80, 100, 50, new { routingPolicy = new { obstacle = "forbidden", clearancePt = 24, text = "avoid" } }, text: Doc.Text("Protected")),
            Doc.Shape(2, 400, 300, 100, 50, new { ports = new[] { new { id = "in", x = 0.0, y = 0.5 } } }),
            Doc.Connector(10,
                new { elementId = Doc.Id(1), glue = "dynamic", preferredSide = "east" },
                new { elementId = Doc.Id(2), glue = "static", port = "in" },
                "orthogonal", new { routingPolicy = new { text = "avoid" } }),
        };
        var routes = new Dictionary<string, JsonObject> { [Doc.Id(10)] = Doc.Route((160, 105), (250, 105), (250, 325), (400, 325)) };
        var exp = RT.Export(Doc.Snapshot(Doc.Make([Doc.Page(shapes)]), routes));

        Assert.NotEmpty(exp.Package);
        var policyDiagnostics = exp.Diagnostics.Where(d => d.Code == "ROUTING_POLICY_NOT_NATIVE").ToList();
        Assert.Equal(5, policyDiagnostics.Count);
        Assert.All(policyDiagnostics, d => Assert.Equal("info", d.Severity));
        Assert.Contains(policyDiagnostics, d => d.ElementId == Doc.Id(1) && d.Action == "routingPolicy.obstacle");
        Assert.Contains(policyDiagnostics, d => d.ElementId == Doc.Id(1) && d.Action == "routingPolicy.clearancePt");
        Assert.Contains(policyDiagnostics, d => d.ElementId == Doc.Id(1) && d.Action == "routingPolicy.text");
        Assert.Contains(policyDiagnostics, d => d.ElementId == Doc.Id(10) && d.Action == "routingPolicy.text");
        Assert.Contains(policyDiagnostics, d => d.ElementId == Doc.Id(10) && d.Action == "from.preferredSide");
        Assert.DoesNotContain(policyDiagnostics, d => d.Action == "to.preferredSide"); // the named static port is already represented natively

        var shape = ShapeByAgentId(exp.Package, Doc.Id(1));
        Assert.Contains(shape.Descendants(), e => e.Name.LocalName == "Row" && (string?)e.Attribute("T") == "MoveTo");
        Assert.Contains(shape.Descendants(), e => e.Name.LocalName == "Row" && (string?)e.Attribute("T") == "LineTo");
        var connector = ShapeByAgentId(exp.Package, Doc.Id(10));
        var routeRows = connector.Descendants().Where(e => e.Name.LocalName == "Row" && ((string?)e.Attribute("T") is "MoveTo" or "LineTo")).ToList();
        Assert.Equal(4, routeRows.Count);
    }

    [Fact]
    public void R24RoutingMetadataLossIsReportedAndAutomaticGeometryRoundTrips()
    {
        var points = new[] { new { x = 100.0, y = 80.0 }, new { x = 100.0, y = 150.0 }, new { x = 350.0, y = 150.0 }, new { x = 350.0, y = 340.0 } };
        var elements = new object[]
        {
            Doc.Shape(1, 50, 80, 100, 60), Doc.Shape(2, 300, 280, 100, 60),
            Doc.Connector(10,
                new { elementId = Doc.Id(1), glue = "dynamic", requiredSide = "north" },
                new { elementId = Doc.Id(2), glue = "dynamic", requiredSide = "south" },
                "orthogonal",
                new { routingPolicy = new { crossing = "allow", priority = 25 }, routing = new { advisory = points, beautified = true } }),
        };
        var documentJson = JsonSerializer.SerializeToNode(Doc.Make([Doc.Page(elements)]), ContractJson.Options)!.AsObject();
        documentJson["routingDefaults"] = new JsonObject { ["crossing"] = "avoid" };
        var document = documentJson.Deserialize<DiagramDocument>(ContractJson.Options)!;
        var routes = new Dictionary<string, JsonObject> { [Doc.Id(10)] = Doc.Route(points.Select(p => (p.x, p.y)).ToArray()) };

        var (exported, imported) = RT.Trip(Doc.Snapshot(document, routes));
        var diagnostics = exported.Diagnostics.Where(d => d.Code == "ROUTING_POLICY_NOT_NATIVE").ToList();
        var expectedActions = new[]
        {
            "routingDefaults.crossing", "routingPolicy.crossing", "routingPolicy.priority",
            "from.requiredSide", "to.requiredSide", "routing.beautified",
        };
        Assert.Equal(expectedActions.OrderBy(x => x), diagnostics.Select(d => d.Action).OrderBy(x => x));
        Assert.All(diagnostics, d => Assert.Equal("info", d.Severity));

        var shape = ShapeByAgentId(exported.Package, Doc.Id(10));
        var rows = shape.Descendants().Where(e => e.Name.LocalName == "Row" && ((string?)e.Attribute("T") is "MoveTo" or "LineTo")).ToList();
        Assert.Equal(points.Length, rows.Count);
        double Inches(string name) => double.Parse(Cell(shape, name)!, System.Globalization.CultureInfo.InvariantCulture);
        var originX = (Inches("PinX") - Inches("LocPinX")) * 72;
        var originY = (Inches("PinY") - Inches("LocPinY")) * 72;
        const double pageHeightPt = 595.2755905511812;
        for (var i = 0; i < points.Length; i++)
        {
            double Local(string name) => double.Parse(rows[i].Elements().First(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == name).Attribute("V")!.Value, System.Globalization.CultureInfo.InvariantCulture);
            Assert.Equal(points[i].x, originX + Local("X") * 72, 6);
            Assert.Equal(points[i].y, pageHeightPt - (originY + Local("Y") * 72), 6);
        }

        var importedConnector = RT.El(imported.Document, Doc.Id(10));
        Assert.Empty(importedConnector["waypoints"]!.AsArray()); // it remains Automatic, not converted to Manual
        var advisory = importedConnector["routing"]!["advisory"]!.AsArray();
        Assert.Equal(points.Length, advisory.Count);
        for (var i = 0; i < points.Length; i++)
        {
            Assert.Equal(points[i].x, advisory[i]!["x"]!.GetValue<double>());
            Assert.Equal(points[i].y, advisory[i]!["y"]!.GetValue<double>());
        }
        Assert.Null(importedConnector["routing"]!["beautified"]); // the next planner pass may apply its normal straightening rule
        Assert.Null(importedConnector["routingPolicy"]);
        Assert.Null(importedConnector["from"]!["requiredSide"]);
        Assert.Null(importedConnector["to"]!["requiredSide"]);
        Assert.Null(imported.Document.RoutingDefaults);
    }

    [Fact]
    public void OnlyAuthoredWaypointRoutesAreFixedAgainstVisioRerouting()
    {
        var wp = new[] { new { x = 200.0, y = 40.0 }, new { x = 200.0, y = 300.0 } };
        var shapes = new object[]
        {
            Doc.Shape(1, 60, 80, 100, 50, new { alias = "a" }), Doc.Shape(2, 400, 80, 100, 50, new { alias = "b" }),
            Doc.Connector(10, Doc.Glue(1), Doc.Glue(2), "orthogonal", new { waypoints = wp }),
            Doc.Connector(11, Doc.Glue(1), Doc.Glue(2), "orthogonal"),
            Doc.Connector(12, Doc.Glue(1), Doc.Glue(2), "straight"),
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));
        var page = Fx.Part(exp.Package, "visio/pages/page1.xml");
        string? Fixed(string agentId) => page.Descendants().Where(e => e.Name.LocalName == "Shape")
            .First(sh => sh.Descendants().Any(r => r.Name.LocalName == "Row" && (string?)r.Attribute("N") == "AgentId" && r.Elements().Any(c => (string?)c.Attribute("V") == agentId)))
            .Elements().FirstOrDefault(c => c.Name.LocalName == "Cell" && (string?)c.Attribute("N") == "ConFixedCode")?.Attribute("V")?.Value;
        Assert.Equal("1", Fixed(Doc.Id(10)));   // steered by the author: Visio must keep the bends and move only the glued ends
        Assert.Null(Fixed(Doc.Id(11)));          // automatic: Visio may reroute it
        Assert.Null(Fixed(Doc.Id(12)));
        Assert.Equal(2, RT.El(back.Document, Doc.Id(10))["waypoints"]!.AsArray().Count); // and the waypoints still come back
    }

    [Fact]
    public void ArrowSizesSurviveTheRoundTripAndMediumStaysImplicit()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 60, 80, 100, 50, new { alias = "a" }), Doc.Shape(2, 400, 80, 100, 50, new { alias = "b" }),
            Doc.Connector(10, Doc.Glue(1), Doc.Glue(2), "straight", new { style = new { colour = "#334155", widthPt = 2.25, dash = "solid", startArrow = "block", endArrow = "block", startArrowSize = "small", endArrowSize = "large" } }),
            Doc.Connector(11, Doc.Glue(1), Doc.Glue(2), "straight", new { style = new { colour = "#334155", widthPt = 2.25, dash = "solid", startArrow = "none", endArrow = "block" } }),
        };
        var (_, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));
        var sized = RT.El(back.Document, Doc.Id(10))["style"]!;
        Assert.Equal("small", sized["startArrowSize"]!.GetValue<string>());
        Assert.Equal("large", sized["endArrowSize"]!.GetValue<string>());
        var plain = RT.El(back.Document, Doc.Id(11))["style"]!.AsObject();
        Assert.False(plain.ContainsKey("startArrowSize"));
        Assert.False(plain.ContainsKey("endArrowSize"));
    }

    [Fact]
    public void ConnectorStyleArrowsLabelAndGlueToAMissingPort()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 60, 80, 100, 50, new { alias = "a" }), Doc.Shape(2, 400, 80, 100, 50, new { alias = "b" }),
            Doc.Connector(10, Doc.Glue(1, "static", "nowhere"), Doc.Glue(2), "straight", new
            {
                style = new { colour = "#cc0000", widthPt = 3, dash = "dotted", startArrow = "oval", endArrow = "diamond" }, label = Doc.Text("flows", new { fontSizePt = 10 }),
            }),
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));
        var c = RT.El(back.Document, Doc.Id(10));
        Assert.Equal("#cc0000", c["style"]!["colour"]!.GetValue<string>());
        Near(3, c["style"]!["widthPt"]!.GetValue<double>());
        Assert.Equal("dotted", c["style"]!["dash"]!.GetValue<string>());
        Assert.Equal("oval", c["style"]!["startArrow"]!.GetValue<string>());
        Assert.Equal("diamond", c["style"]!["endArrow"]!.GetValue<string>());
        Assert.Equal("flows", c["label"]!["value"]!.GetValue<string>());
        Near(10, c["label"]!["fontSizePt"]!.GetValue<double>());
        // the port does not exist: said so, and the end falls back to gluing to the shape
        Assert.Contains(exp.Diagnostics, d => d.Code == "port_glue_dropped" && d.ElementId == Doc.Id(10));
        Assert.Equal("dynamic", c["from"]!["glue"]!.GetValue<string>());
    }

    [Fact]
    public void ADynamicEndStartsWhereTheLineLeavesTheShape()
    {
        var shapes = new object[] { Doc.Shape(1, 100, 100, 100, 50), Doc.Shape(2, 400, 100, 100, 50), Doc.Connector(10, Doc.Glue(1), Doc.Glue(2)) };
        var exp = RT.Export(Doc.Snapshot(Doc.Page(shapes)));
        var c = ShapeByAgentId(exp.Package, Doc.Id(10));
        var inch = (string n) => double.Parse(Cell(c, n)!, System.Globalization.CultureInfo.InvariantCulture) * 72;
        Near(200, inch("BeginX"), 1e-6); // right edge of the first shape
        Near(400, inch("EndX"), 1e-6);   // left edge of the second
    }

    // ---------------------------------------------------------------- groups and stacking

    [Fact]
    public void GroupsKeepTheirStructureAndMembersScaleWithThem()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 60, 40, new { alias = "a" }), Doc.Shape(2, 200, 150, 60, 40, new { alias = "b" }, preset: "ellipse"),
            Doc.Shape(3, 400, 100, 60, 40, new { alias = "c" }), Doc.Shape(4, 480, 160, 60, 40, new { alias = "d" }),
            JsonSerializer.SerializeToNode(new { id = Doc.Id(20), kind = "group", alias = "inner", layerIds = Array.Empty<string>(), zIndex = 4, locked = false, hidden = false, bounds = new { x = 100, y = 100, width = 160, height = 90 }, rotationDeg = 0, metadata = new { }, childIds = new[] { Doc.Id(1), Doc.Id(2) } })!,
            JsonSerializer.SerializeToNode(new { id = Doc.Id(21), kind = "group", alias = "outer", layerIds = Array.Empty<string>(), zIndex = 4, locked = false, hidden = false, bounds = new { x = 100, y = 100, width = 440, height = 100 }, rotationDeg = 0, metadata = new { }, childIds = new[] { Doc.Id(20), Doc.Id(3), Doc.Id(4) } })!,
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes.Select(s => (object)s))));
        var page = Fx.Part(exp.Package, "visio/pages/page1.xml");
        var topShapes = page.Root!.Elements().First(e => e.Name.LocalName == "Shapes").Elements().ToList();
        Assert.Single(topShapes); // the outer group is the only page-level shape
        var outer = topShapes[0];
        Assert.Equal("Group", (string?)outer.Attribute("Type"));
        var inner = outer.Elements().First(e => e.Name.LocalName == "Shapes").Elements().First(e => (string?)e.Attribute("Type") == "Group");
        // members are written as fractions of the group's own size, as Visio does, so resizing the group in Visio scales them
        var a = inner.Elements().First(e => e.Name.LocalName == "Shapes").Elements().First();
        Assert.StartsWith($"Sheet.{(string)inner.Attribute("ID")!}!Width*", CellF(a, "Width"));
        Assert.StartsWith($"Sheet.{(string)inner.Attribute("ID")!}!Width*", CellF(a, "PinX"));

        var doc = back.Document;
        var o = RT.El(doc, Doc.Id(21));
        Assert.Equal("group", o["kind"]!.GetValue<string>());
        Assert.Equal(new[] { Doc.Id(20), Doc.Id(3), Doc.Id(4) }.OrderBy(x => x), o["childIds"]!.AsArray().Select(n => n!.GetValue<string>()).OrderBy(x => x));
        var i = RT.El(doc, Doc.Id(20));
        Assert.Equal(new[] { Doc.Id(1), Doc.Id(2) }.OrderBy(x => x), i["childIds"]!.AsArray().Select(n => n!.GetValue<string>()).OrderBy(x => x));
        Assert.Equal("inner", i["alias"]!.GetValue<string>());
        var members = RT.El(doc, Doc.Id(2))["bounds"]!;
        Near(200, members["x"]!.GetValue<double>()); Near(150, members["y"]!.GetValue<double>()); Near(60, members["width"]!.GetValue<double>());
        // derived bounds: the tight union of the members, rotation zero
        var ob = o["bounds"]!;
        Near(100, ob["x"]!.GetValue<double>()); Near(100, ob["y"]!.GetValue<double>()); Near(440, ob["width"]!.GetValue<double>()); Near(100, ob["height"]!.GetValue<double>());
        Assert.Equal(0, o["rotationDeg"]!.GetValue<double>());
    }

    [Fact]
    public void ConnectorMembersOfAGroupStayOnThePageAndRejoinTheGroup()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 60, 40), Doc.Shape(2, 300, 100, 60, 40), Doc.Connector(10, Doc.Glue(1), Doc.Glue(2)),
            JsonSerializer.SerializeToNode(new { id = Doc.Id(20), kind = "group", layerIds = Array.Empty<string>(), zIndex = 3, locked = false, hidden = false, bounds = new { x = 100, y = 100, width = 260, height = 40 }, rotationDeg = 0, metadata = new { }, childIds = new[] { Doc.Id(1), Doc.Id(2), Doc.Id(10) } })!,
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));
        var g = RT.El(back.Document, Doc.Id(20));
        Assert.Contains(Doc.Id(10), g["childIds"]!.AsArray().Select(n => n!.GetValue<string>()));
        Assert.Equal("connector", RT.El(back.Document, Doc.Id(10))["kind"]!.GetValue<string>());
        Assert.Equal("static".Length > 0 ? "dynamic" : "", RT.El(back.Document, Doc.Id(10))["from"]!["glue"]!.GetValue<string>());
    }

    [Fact]
    public void StackingOrderIsDocumentOrderAndComesBackInTheSameOrder()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 100, 60, z: 30), Doc.Shape(2, 120, 110, 100, 60, z: 10), Doc.Shape(3, 140, 120, 100, 60, z: 20), Doc.Shape(4, 160, 130, 100, 60, z: 40),
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));
        var written = Fx.Part(exp.Package, "visio/pages/page1.xml").Descendants().Where(e => e.Name.LocalName == "Shape").Select(s => Cell(s, "PinX")).ToList();
        Assert.Equal(4, written.Count);
        var ids = RT.All(back.Document).OrderBy(e => e["zIndex"]!.GetValue<int>()).Select(e => e["id"]!.GetValue<string>()).ToList();
        Assert.Equal(new[] { Doc.Id(2), Doc.Id(3), Doc.Id(1), Doc.Id(4) }, ids); // back to front
        Assert.Equal(4, RT.All(back.Document).Select(e => e["zIndex"]!.GetValue<int>()).Distinct().Count()); // no ties
    }

    [Fact]
    public void NonzeroLevelsRoundTripInEffectiveOrderWithoutChangingSchemaMarker()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 100, 60, new { level = 2 }, z: 1),
            Doc.Shape(2, 220, 100, 100, 60, new { level = -1 }, z: 20),
            Doc.Shape(3, 340, 100, 100, 60, z: 30),
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes)));
        var xml = Fx.Part(exp.Package, "visio/pages/page1.xml");
        var drawnIds = xml.Root!.Element(xml.Root.Name.Namespace + "Shapes")!.Elements()
            .Select(s => UserValue(s, "AgentId")).Where(s => s is not null).ToList();
        Assert.Equal(new[] { Doc.Id(2), Doc.Id(3), Doc.Id(1) }, drawnIds);
        Assert.Equal("-1", UserValue(ShapeByAgentId(exp.Package, Doc.Id(2)), "AgentLevel"));
        Assert.Null(UserValue(ShapeByAgentId(exp.Package, Doc.Id(3)), "AgentLevel"));
        Assert.Equal("2", UserValue(ShapeByAgentId(exp.Package, Doc.Id(1)), "AgentLevel"));
        var marker = Fx.Part(exp.Package, "visio/document.xml").Descendants().First(e => e.Name.LocalName == "Row" && (string?)e.Attribute("N") == "AgentSchemaVersion");
        Assert.Equal("1", (string?)marker.Elements().First(e => e.Name.LocalName == "Cell").Attribute("V"));
        var ordered = RT.All(back.Document).OrderBy(e => e["level"]?.GetValue<int>() ?? 0).ThenBy(e => e["zIndex"]!.GetValue<int>()).ToList();
        Assert.Equal(new[] { Doc.Id(2), Doc.Id(3), Doc.Id(1) }, ordered.Select(e => e["id"]!.GetValue<string>()));
        Assert.Equal(new[] { -1, 0, 2 }, ordered.Select(e => e["level"]?.GetValue<int>() ?? 0));
        Assert.Contains(exp.Diagnostics, d => d.Code == "level_not_native" && d.ElementId == Doc.Id(1));
    }

    [Fact]
    public void MixedLevelGroupReportsExpectedBlockInterleaving()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 60, 40, new { level = -1 }, z: 1),
            Doc.Shape(2, 300, 100, 60, 40, new { level = 1 }, z: 5),
            Doc.Shape(3, 200, 100, 60, 40, z: 3),
            JsonSerializer.SerializeToNode(new { id = Doc.Id(20), kind = "group", layerIds = Array.Empty<string>(), zIndex = 5, level = 1, locked = false, hidden = false, bounds = new { x = 100, y = 100, width = 260, height = 40 }, rotationDeg = 0, metadata = new { }, childIds = new[] { Doc.Id(1), Doc.Id(2) } })!,
        };
        var exp = RT.Export(Doc.Snapshot(Doc.Page(shapes)));
        Assert.Contains(exp.Diagnostics, d => d.Code == "group_stacking_flattened" && d.ElementId == Doc.Id(20));
    }

    [Fact]
    public void ConflictingVisioOrderKeepsAgentLevelAndReportsTheResolution()
    {
        var exp = RT.Export(Doc.Snapshot(Doc.Page([
            Doc.Shape(1, 100, 100, 60, 40, new { level = 2 }, z: 1),
            Doc.Shape(2, 200, 100, 60, 40, new { level = -1 }, z: 2),
        ])));
        var conflicted = Fx.Edit(exp.Package, "visio/pages/page1.xml", d =>
        {
            var shapes = d.Root!.Element(d.Root.Name.Namespace + "Shapes")!;
            var nodes = shapes.Elements().ToArray();
            shapes.ReplaceNodes(nodes.Reverse());
        });
        var imported = RT.Import(conflicted);
        Assert.Contains(imported.Diagnostics, d => d.Code == "level_order_conflict" && d.Severity == "info");
        var byId = RT.All(imported.Document).ToDictionary(e => e["id"]!.GetValue<string>());
        Assert.Equal(2, byId[Doc.Id(1)]["level"]!.GetValue<int>());
        Assert.Equal(-1, byId[Doc.Id(2)]["level"]!.GetValue<int>());
        Assert.True(byId[Doc.Id(1)]["zIndex"]!.GetValue<int>() > byId[Doc.Id(2)]["zIndex"]!.GetValue<int>());
    }

    [Fact]
    public void InvalidAgentLevelFallsBackToZeroWithDiagnostic()
    {
        var exp = RT.Export(Doc.Snapshot(Doc.Page([Doc.Shape(1, 100, 100, 60, 40, new { level = 2 })])));
        var invalid = Fx.Edit(exp.Package, "visio/pages/page1.xml", d =>
        {
            var row = d.Descendants().First(e => e.Name.LocalName == "Row" && (string?)e.Attribute("N") == "AgentLevel");
            row.Elements().First(e => e.Name.LocalName == "Cell")!.SetAttributeValue("V", "128");
        });
        var imported = RT.Import(invalid);
        Assert.Contains(imported.Diagnostics, d => d.Code == "level_invalid" && d.Severity == "warning");
        Assert.Null(RT.El(imported.Document, Doc.Id(1))["level"]);
    }

    [Fact]
    public void AGroupDrawsAsABlockSoInterleavedStackingIsReported()
    {
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 60, 40, z: 1), Doc.Shape(2, 300, 100, 60, 40, z: 5), Doc.Shape(3, 200, 100, 60, 40, z: 3),
            JsonSerializer.SerializeToNode(new { id = Doc.Id(20), kind = "group", layerIds = Array.Empty<string>(), zIndex = 5, locked = false, hidden = false, bounds = new { x = 100, y = 100, width = 260, height = 40 }, rotationDeg = 0, metadata = new { }, childIds = new[] { Doc.Id(1), Doc.Id(2) } })!,
        };
        var exp = RT.Export(Doc.Snapshot(Doc.Page(shapes)));
        Assert.Contains(exp.Diagnostics, d => d.Code == "group_stacking_flattened" && d.ElementId == Doc.Id(20));
    }

    // ---------------------------------------------------------------- layers, flags, ports

    [Fact]
    public void LayersMembershipAndTheirFlagsRoundTrip()
    {
        var layers = new object[]
        {
            Doc.Layer(Doc.LayerA, "Network", visible: false, locked: true, printable: false), Doc.Layer(Doc.LayerB, "Notes", colour: "#336699"),
        };
        var shapes = new object[]
        {
            Doc.Shape(1, 100, 100, 60, 40, new { layerIds = new[] { Doc.LayerA } }), Doc.Shape(2, 200, 100, 60, 40, new { layerIds = new[] { Doc.LayerB, Doc.LayerA } }), Doc.Shape(3, 300, 100, 60, 40),
        };
        var (exp, back) = RT.Trip(Doc.Snapshot(Doc.Page(shapes, layers: layers)));
        var p = back.Document.Pages[0];
        var network = p.Layers.First(l => l.Name == "Network"); var notes = p.Layers.First(l => l.Name == "Notes");
        Assert.Equal(Doc.LayerA, network.Id); Assert.Equal(Doc.LayerB, notes.Id);
        Assert.False(network.Visible); Assert.True(network.Locked); Assert.False(network.Printable);
        Assert.True(notes.Visible && !notes.Locked && notes.Printable);
        Assert.Equal("#336699", notes.ColourOverride);
        Assert.Equal(new[] { Doc.LayerA }, ((JsonArray)RT.El(back.Document, Doc.Id(1))["layerIds"]!).Select(n => n!.GetValue<string>()));
        Assert.Equal(new[] { Doc.LayerA, Doc.LayerB }.OrderBy(x => x), ((JsonArray)RT.El(back.Document, Doc.Id(2))["layerIds"]!).Select(n => n!.GetValue<string>()).OrderBy(x => x)); // several layers per shape
        Assert.Empty((JsonArray)RT.El(back.Document, Doc.Id(3))["layerIds"]!);
        // and they are real Visio layer rows
        var sheet = Fx.Part(exp.Package, "visio/pages/pages.xml").Descendants().First(e => e.Name.LocalName == "Section" && (string?)e.Attribute("N") == "Layer");
        Assert.Equal(2, sheet.Elements().Count());
        Assert.Equal("0", sheet.Elements().First().Elements().First(c => (string?)c.Attribute("N") == "Visible").Attribute("V")!.Value);
        Assert.Equal("1", sheet.Elements().First().Elements().First(c => (string?)c.Attribute("N") == "Lock").Attribute("V")!.Value);
        Assert.Equal("0", sheet.Elements().First().Elements().First(c => (string?)c.Attribute("N") == "Print").Attribute("V")!.Value);
    }

    [Fact]
    public void LayersAreMatchedByNameWhenVisioReindexesThem()
    {
        var layers = new object[] { Doc.Layer(Doc.LayerA, "First"), Doc.Layer(Doc.LayerB, "Second", visible: false) };
        var shapes = new object[] { Doc.Shape(1, 100, 100, 60, 40, new { layerIds = new[] { Doc.LayerB } }) };
        var exp = RT.Export(Doc.Snapshot(Doc.Page(shapes, layers: layers)));
        // Visio swapped the layer rows; membership numbers follow the rows
        var swapped = Fx.Edit(exp.Package, "visio/pages/pages.xml", d =>
        {
            var sec = d.Descendants().First(e => e.Name.LocalName == "Section" && (string?)e.Attribute("N") == "Layer");
            var rows = sec.Elements().ToList(); rows[0].Remove(); rows[1].Remove();
            rows[1].SetAttributeValue("IX", 0); rows[0].SetAttributeValue("IX", 1);
            sec.Add(rows[1], rows[0]);
        });
        swapped = Fx.Edit(swapped, "visio/pages/page1.xml", d => d.Descendants().First(e => e.Name.LocalName == "Cell" && (string?)e.Attribute("N") == "LayerMember").SetAttributeValue("V", "0"));
        var back = RT.Import(swapped);
        var p = back.Document.Pages[0];
        Assert.Equal(Doc.LayerB, p.Layers.First(l => l.Name == "Second").Id);
        Assert.Equal(Doc.LayerA, p.Layers.First(l => l.Name == "First").Id);
        Assert.Equal(new[] { Doc.LayerB }, ((JsonArray)RT.El(back.Document, Doc.Id(1))["layerIds"]!).Select(n => n!.GetValue<string>()));
    }

    [Fact]
    public void PortsKeepTheirIdsAndPositions()
    {
        var shapes = new object[] { Doc.Shape(1, 100, 100, 100, 60, new { ports = new[] { new { id = "left", x = 0.0, y = 0.5 }, new { id = "top-third", x = 0.33, y = 0.0 } } }) };
        var s = RT.El(RT.Trip(Doc.Snapshot(Doc.Page(shapes))).Back.Document, Doc.Id(1));
        var ports = s["ports"]!.AsArray();
        Assert.Equal(2, ports.Count);
        Assert.Equal("left", ports[0]!["id"]!.GetValue<string>());
        Near(0.33, ports[1]!["x"]!.GetValue<double>(), 1e-6);
        Assert.Equal("top-third", ports[1]!["id"]!.GetValue<string>());
    }

    // ---------------------------------------------------------------- pages

    [Fact]
    public void SeveralPagesKeepTheirOrderNamesAndContents()
    {
        var p1 = Doc.Page([Doc.Shape(1, 50, 50, 60, 40, new { alias = "one" })]);
        var p2 = Doc.Page([Doc.Shape(2, 70, 70, 60, 40, new { alias = "one" })], new { id = Doc.Id(500), name = "Detail" });
        var doc = Doc.Make([p1, p2]);
        var back = RT.Trip(Doc.Snapshot(doc)).Back.Document;
        Assert.Equal(new[] { "Page 1", "Detail" }, back.Pages.Select(p => p.Name));
        Assert.Equal(Doc.Id(500), back.Pages[1].Id);
        Assert.Equal("one", RT.El(back, Doc.Id(2), 1)["alias"]!.GetValue<string>()); // aliases are page-scoped: the same one on two pages is fine
        Assert.Equal("one", RT.El(back, Doc.Id(1), 0)["alias"]!.GetValue<string>());
    }

    [Fact]
    public void AnEmptyPageAndNoGlueAtAllStillExport()
    {
        var back = RT.Trip(Doc.Snapshot(Doc.Page([]))).Back.Document;
        Assert.Empty(back.Pages[0].Elements);
    }

    [Fact]
    public void ExportRefusesAProjectionFromAnotherRevisionOrDocument()
    {
        var doc = Doc.Make([Doc.Page([Doc.Shape(1, 10, 10, 50, 30)])]);
        var good = Doc.Snapshot(doc);
        var stale = good with { Projection = good.Projection with { Revision = good.Revision + 1 } };
        var r = RT.Exporter.ExportAsync(stale, new Blobs(), new ExportOptions(), CancellationToken.None).GetAwaiter().GetResult();
        Assert.False(r.IsOk);
        Assert.Equal("invalid_request", r.Error!.Code);
        var other = good with { Projection = good.Projection with { SessionId = Doc.Id(1234) } };
        Assert.False(RT.Exporter.ExportAsync(other, new Blobs(), new ExportOptions(), CancellationToken.None).GetAwaiter().GetResult().IsOk);
    }

    [Fact]
    public void TheSamePackageIsProducedTwiceByteForByte()
    {
        var (snap, blobs, _) = SampleScene.Build();
        Assert.Equal(RT.Export(snap, blobs).Package, RT.Export(snap, blobs).Package);
    }
}

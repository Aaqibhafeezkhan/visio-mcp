using System.Text.Json.Nodes;

namespace Diagram.Mcp;

/// <summary>Offline discovery from the same contracts used to generate runtime validators.</summary>
internal static class OperationCatalog
{
    static readonly JsonObject Operations = Load("operations.schema.json");
    static readonly JsonObject Document = Load("document.schema.json");
    static readonly JsonObject Protocol = Load("protocol.schema.json");
    static readonly JsonObject Examples = Load("operation-examples.json");
    static readonly IReadOnlyDictionary<string, string> Definitions = Operations["$defs"]!["Operation"]!["oneOf"]!.AsArray()
        .Select(r => r!["$ref"]!.GetValue<string>().Split('/').Last())
        .ToDictionary(d => Operations["$defs"]![d]!["properties"]!["op"]!["const"]!.GetValue<string>(), d => d, StringComparer.Ordinal);

    static JsonObject Load(string name)
    {
        using var stream = typeof(OperationCatalog).Assembly.GetManifestResourceStream("Diagram.Mcp.Contracts." + name)
            ?? throw new InvalidOperationException("Missing embedded contract: " + name);
        return JsonNode.Parse(stream)!.AsObject();
    }

    public static JsonObject? Describe(string? operation)
    {
        if (operation is not null && !Definitions.ContainsKey(operation)) return null;
        var result = new JsonObject
        {
            ["guidance"] = new JsonObject
            {
                ["coordinates"] = "Geometry and font sizes are in points (72 points = 1 inch). Origin top-left, y increases downwards; rotation is clockwise in degrees around the centre.",
                ["targets"] = "Prefer element UUIDs from get_document_summary or get_objects. Resolution is UUID, then page-scoped alias, then exact name; ambiguous names fail. apply_operations has no page scope parameter: aliases/names work only in a one-page document. Use UUIDs on multipage documents. A creation operation's pageId chooses its destination page.",
                ["transactions"] = "Call get_document_summary for documentId, sessionId and baseRevision. Send operations to apply_operations with a new transactionId UUID. Batches are atomic. Retry an unknown outcome with the identical transactionId and payload; after a revision conflict, read the summary and replan with a new transactionId.",
                ["editing"] = "Use resize for bounds, move for translation, rotate for rotation, and set for text/style/name/level patches. Omitted patch leaves are preserved; only schema-defined nullable fields may be cleared with null. Arrays replace atomically. Elements stack by level first, then zIndex; missing level means 0 and setting level to 0 removes the stored field. Routing: a connector runs over shapes on a lower level than its own (a background or frame sent back a level) and avoids shapes on its level or above; an explicit routingPolicy.obstacle on the shape overrides this. Group level changes move the entire subtree while preserving member offsets. Group rotation uses deltaDeg, not angleDeg. Containers: a shape with container.memberIds holds other elements (containers nest); moving it moves every member at every depth, resizing it never scales them, and fit grow or fit resizes it around its members. Membership changes only through contain (add/remove) or createShape.container; deleting a container with members needs members delete or keep.",
                ["examples"] = "Examples are independent request fragments, not a runnable batch. Replace UUIDs with existing object/page/layer IDs. Targets must be of the appropriate kind, editable and unlocked. Image operations require approved document assets: use list_assets and execute_script with libraryAssets to import library pictures. registerAsset cannot upload arbitrary bytes; its placeholder hash must refer to host-prepared bytes.",
            },
            ["limits"] = Protocol["$defs"]!["MutationRequest"]!["properties"]!["operations"]!.DeepClone(),
        };
        // The limits are useful independently of the protocol's external references.
        result["limits"]!.AsObject().Remove("items");
        if (operation is null)
        {
            result["operations"] = new JsonArray(Definitions.Select(pair => (JsonNode)new JsonObject
            {
                ["operation"] = pair.Key,
                ["required"] = Operations["$defs"]![pair.Value]!["required"]!.DeepClone(),
            }).ToArray());
            result["next"] = "Call get_operation_schema with operation set to one of these exact names for a self-contained JSON Schema and example.";
            return result;
        }
        var defs = new JsonObject();
        var schema = Rewrite(Operations["$defs"]![Definitions[operation]]!, defs, Operations).AsObject();
        schema["$schema"] = Operations["$schema"]!.DeepClone();
        schema["$defs"] = defs;
        result["operation"] = operation;
        result["schema"] = schema;
        result["example"] = Examples[operation]!.DeepClone();
        return result;
    }

    // Collect only the transitive definitions this operation uses, rewriting references
    // to local pointers so a client can validate without filesystem or network access.
    static JsonNode Rewrite(JsonNode source, JsonObject definitions, JsonObject owner)
    {
        if (source is JsonObject obj)
        {
            var copy = new JsonObject();
            foreach (var (key, value) in obj)
            {
                if (key == "$ref")
                {
                    var reference = value!.GetValue<string>();
                    var name = reference.Split('/').Last();
                    if (!definitions.ContainsKey(name))
                    {
                        definitions[name] = null; // Reserve first to handle recursive definitions.
                        var origin = reference.StartsWith("document.schema.json", StringComparison.Ordinal) ? Document
                            : reference.StartsWith("operations.schema.json", StringComparison.Ordinal) ? Operations : owner;
                        definitions[name] = Rewrite(origin["$defs"]![name]!, definitions, origin);
                    }
                    copy[key] = "#/$defs/" + name;
                }
                else copy[key] = value is null ? null : Rewrite(value, definitions, owner);
            }
            return copy;
        }
        if (source is JsonArray arr) return new JsonArray(arr.Select(v => v is null ? null : Rewrite(v, definitions, owner)).ToArray());
        return source.DeepClone();
    }
}

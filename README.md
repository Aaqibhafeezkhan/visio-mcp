# visio-mcp

A Windows desktop diagram editor that a person and an LLM can edit together, with
native Microsoft Visio (`.vsdx`) files that stay editable in Visio rather than being
flattened into a picture.

- **Human editing:** shapes, glued connectors, text, images, layers, align and format,
  on a page-oriented canvas.
- **Agent editing:** an MCP server exposes typed, atomic, revision-checked operations on
  objects with persistent IDs, so an agent can change one object without regenerating
  the drawing. It can also render pages and regions to check its own layout.
- **Visio interoperability:** export and re-import of `.vsdx`, keeping agent IDs in
  Visio user cells across a round trip.

Planned stack: React + TypeScript + maxGraph, a .NET 10 WPF/WebView2 host, OfficeIMO.Visio
and the official C# MCP SDK.

## Status

Early stage. The design and implementation plan are done. Package **I00** (pinned probe
dependencies and a minimal request-envelope schema) is complete. Next are the M0 feasibility
probes, which must prove that editable `.vsdx` files with glued connectors work in real
Visio and Word before any production code is written.
See [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md).

## Layout

| Path | Contents |
|---|---|
| [`agentic-visio-mvp-spec.md`](agentic-visio-mvp-spec.md) | Original MVP specification |
| [`docs/design/`](docs/design/README.md) | Agreed architecture and design decisions |
| [`docs/superpowers/plans/`](docs/superpowers/plans/2026-10-02-agentic-diagram-implementation.md) | Implementation plan (packages I00–I52) |
| [`docs/m0/`](docs/m0/) | Pinned dependency versions and run environments |
| [`spikes/`](spikes/README.md) | Disposable M0 feasibility probes |

## Running the contract tests

Requires Node.js 24.

```sh
cd spikes/contract-tests
npm ci
npm test
```

## MCP operation discovery

Before constructing an `apply_operations` batch, call `get_operation_schema` with
no arguments to list the supported operation names. Call it again with, for example,
`{"operation":"resize"}` to get a self-contained JSON Schema, an example operation,
coordinate units, batch limits and targeting guidance. Discovery works even when the
desktop editor is closed. Schemas are embedded from `contracts/` at build time.

Read `get_document_summary` before editing to obtain the document/session identity,
current revision and object UUIDs. Example UUIDs and asset references are placeholders;
replace them with actual identities and approved assets. Use `resize` for bounds,
`move` for position and `set` for text/style patches. Prefer UUID targets on multipage
documents. See `contracts/fixtures/operation-examples.json` for the validated examples.

To straighten or tidy connectors, call `propose_routes` with `connectorIds` (or a
`pageId` for the whole page) first. It changes nothing and returns each route's points
in page points, whether the drawing would change, and route findings. When it returns
`commit`, apply `commit.operations` unchanged with `apply_operations` at
`commit.baseRevision` and a new `transactionId`. `dependency_conflict` names other
connectors the reroute would change. See [R25](docs/m5/R25-route-proposals.md).

For existing labels, call `get_text_layout` with `documentId`, `sessionId` and `ids`.
It returns measurements and suggested operations without changing the document.
Choose `strategy: "grow_box"` to preserve font size or `"shrink_font"` to preserve
the box (`minFontSizePt` defaults to 8). Apply the returned `operations` through
`apply_operations` using the returned `revision` as `baseRevision` and a new
transaction UUID. A conflicting edit requires measuring again.

`target: "visio"` adds conservative font/symbol allowances and reports export risks.
These are estimates, not native Visio measurements: render and inspect the export
before relying on its appearance. Requests support at most 50 text objects or
text-bearing shapes and 131,072 characters; groups, connectors and pictures are not
supported by this first text-fitting tool.

## Reference and canvas comparison

Add a reference screenshot with **Pictures → Add to library…**, then call
`list_assets` to obtain its ID, scope and SHA-256 version. The MCP never reads an
agent-supplied file path. These tools support approved PNG, JPEG and BMP references.

- `render_reference_region`: pass document/session identity, `referenceAssetId`,
  `referenceSha256`, `referenceScope` (library or document), and
  `cropPx: {x,y,width,height}` in **integer original-image pixels**. `scale` defaults
  to 8 (range 1–16). The tool returns an enlarged PNG with nearest-pixel sampling.
- `compare_reference`: pass the same source crop plus `pageId` and exactly one of
  canvas `bounds: {x,y,width,height}` in **document points**, or `elementIds`.
  `mode` is `side_by_side` (default) or `overlay`; `panelSizePx` defaults to 512.
  Canvas `paddingPt` defaults to 6 to protect edge strokes. Alias/name lookup is scoped to the page.

Both tools are read-only. Results include the source hash, document revision,
original dimensions, crop and output rectangles, and coordinate mappings. Each
comparison crop is fitted and centred without stretching; different aspect ratios
are reported. The overlay draws the reference first, then the canvas at 50% opacity.
Use side-by-side views for dark-source/light-canvas comparisons. There is no
automatic accuracy score, alignment or reconstruction of missing source detail.
See [R06/R07](docs/m5/R06-R07-reference-comparison.md) for examples and limits.

## Licence

[MIT](LICENSE)

## Vector icons

The Icons panel searches a bundled Lucide subset and places editable vector shapes.
MCP clients can use `search_icons` and `get_icon` to inspect previews and obtain
normal shape operations, then apply those through `apply_operations`.
See [R03 usage and verification](docs/m5/R03-vector-icons.md) for units, supported
custom paths, native Visio behavior and catalogue licensing.

## Reusable layout components

Use **Shapes → Layout components** to preview and insert measured repository
cards, labelled containers, environment columns and vertical pipelines. Select
an existing component to preview reflow after changing its text or width.
MCP clients can discover schemas/examples with `list_layout_components` and get
read-only create/reflow proposals with `get_layout_component`.
See [R04 usage and verification](docs/m5/R04-layout-components.md).

## Install

Per-user install, update, uninstall and MCP registration are described in [docs/install.md](docs/install.md).

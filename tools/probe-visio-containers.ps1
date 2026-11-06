<#
.SYNOPSIS  Shows how the installed Visio records containers (R17 feasibility check), using a master-less shape as the editor exports it.
.PARAMETER Out   Optional path to save the probe drawing as .vsdx, to read the XML Visio writes.
.OUTPUTS    Whether Visio accepts User.msvStructureType = "Container" on a plain shape, the Relationships formulas it writes for direct and
            nested membership, and how msvSDContainerResize and msvSDContainerMargin read back.
.NOTES      Recorded on Visio 16.0 build 20430 (2026-10-24): a plain shape with only the user cell is a container; membership added through the
            API is written as direct (container DEPENDSON 1, member DEPENDSON 4); resize 0/1/2 reads as ResizeAsNeeded 0/1/2; margin is in inches.
            Moving a container's PinX, or a Selection.Move in hidden Visio, does not carry members: that is Visio's interactive behaviour.
#>
param([string]$Out)
$ErrorActionPreference = 'Stop'
$v = New-Object -ComObject Visio.Application; $v.Visible = $false; $v.AlertResponse = 7
function Container($s) { [void]$s.AddNamedRow(242, 'msvStructureType', 0); $s.CellsU('User.msvStructureType').FormulaU = '"Container"' } # 242 = visSectionUser
try {
  "Visio $($v.Version) build $($v.Build)"
  $d = $v.Documents.Add(''); $p = $d.Pages.Item(1)
  $outer = $p.DrawRectangle(0.5, 0.5, 7, 5); $outer.Name = 'outer'
  $inner = $p.DrawRectangle(1, 1, 4, 4); $inner.Name = 'inner'
  $a = $p.DrawRectangle(1.5, 1.5, 2.5, 2.2); $a.Name = 'a'
  $b = $p.DrawRectangle(5, 1.5, 6, 2.2); $b.Name = 'b'
  Container $outer; Container $inner
  "containers recognised: $(@($p.GetContainers(0)).Count) (expect 2)"
  $inner.ContainerProperties.AddMember($a, 1)
  $outer.ContainerProperties.AddMember($inner, 1)
  $outer.ContainerProperties.AddMember($b, 1)
  foreach ($s in $outer, $inner, $a, $b) { "$($s.Name) Relationships = $($s.CellsU('Relationships').FormulaU)" }
  "outer direct members: $(@($outer.ContainerProperties.GetMemberShapes(16)).Count) (16 = exclude nested); all depths: $(@($outer.ContainerProperties.GetMemberShapes(0)).Count)"
  [void]$inner.AddNamedRow(242, 'msvSDContainerResize', 0)
  foreach ($val in 0, 1, 2) { $inner.CellsU('User.msvSDContainerResize').FormulaU = "$val"; "msvSDContainerResize=$val reads as ResizeAsNeeded=$($inner.ContainerProperties.ResizeAsNeeded)" }
  [void]$inner.AddNamedRow(242, 'msvSDContainerMargin', 0); $inner.CellsU('User.msvSDContainerMargin').FormulaU = '0.25 in'
  "msvSDContainerMargin=0.25 in reads as GetMargin(inches)=$($inner.ContainerProperties.GetMargin(65))"
  if ($Out) { $d.SaveAs($Out) } else { $d.Saved = $true }
  $d.Close()
} finally { $v.Quit() }

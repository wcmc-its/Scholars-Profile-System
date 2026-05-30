# Architecture diagrams

Data-driven, version-controlled architecture diagrams for the Scholars Profile
System. Each diagram is a small **data file**; a shared, dependency-free renderer
turns it into a polished SVG, a PNG, and a combined HTML viewer.

```
npm run diagrams            # build everything → docs/architecture/
```

Outputs:

| File | Tracked? | Use |
|---|---|---|
| `docs/architecture/index.html` | yes | the viewer — open in a browser; ⌘P → Save as PDF for slides |
| `docs/architecture/<id>.svg` | yes | one standalone vector per diagram (crisp at any zoom; renders on GitHub) |
| `docs/architecture/<id>.png` | no — `*.png` is gitignored | rasterized for slides/Slack/tickets that won't render SVG; regenerate via `npm run diagrams` |

## Layout

```
scripts/diagrams/
  lib.mjs              # the renderer: palettes, anchors, renderSVG(), validate(). Pure — no DOM, no Node APIs.
  definitions/         # one file per diagram = the source of truth (plain data)
    01-system-context.mjs       # sources + cadence + audiences
    02-app-aws-topology.mjs     # CloudFront→ALB→ECS→data, CDK-stack stripes
    03-network-topology.mjs     # VPC, subnets, SGs, WCM connectivity
    04-edge-topology-fork.mjs   # the NetScaler replace-vs-front decision (#502)
    05-app-internals.mjs        # C4 component view inside the Next.js app
  build.mjs            # validate → SVG → PNG → index.html
  README.md
```

## Editing a diagram

Open its file in `definitions/`. A diagram is a `spec`:

```js
import { A } from "../lib.mjs";

const nodes = {
  ecs: { x: 560, y: 286, w: 310, h: 64, kind: "app",
         title: "ECS Fargate", sub: ["Next.js + OTel"], badge: "AppStack" },
  // …
};
const groups = [{ x: 300, y: 140, w: 840, h: 468, kind: "net", title: "VPC", fo: 0.06 }];
const edges  = [{ p0: A(nodes.cf, "b"), p1: A(nodes.ecs, "t"), color: "maroon", label: "HTTPS" }];

export const spec = { id: "app-aws-topology", vb: [1400, 740], groups, nodes, edges };
export const meta = { nav: "…", kicker: "…", heading: "…", dot: "#0ca678", blurb: "…", legend: [ … ], source: "…" };
```

- **Coordinates** are plain numbers in the `vb` (viewBox) space — no layout engine,
  so what you type is where it lands. `npm run diagrams` fails the build if any two
  nodes overlap or anything falls outside the viewBox, so you get told immediately.
- **`kind`** picks the colour (`ext`, `edge`, `net`, `app`, `data`, `aws`, `good`,
  `open`) — see `KIND` in `lib.mjs`.
- **`badge`** adds a top accent stripe coloured by owning CDK stack — see `STACKC`.
- **`chip: { tone, text }`** adds a right-aligned status pill (e.g. ETL cadence) — tones in `CHIP`.
- **`A(node, side, f)`** anchors an edge to a node side (`t`/`b`/`l`/`r`), `f` in
  `[0,1]` sliding along that side. Edges auto-curve; pass `points: [{x,y},…]` to
  hand-route around obstacles, `dash: true` for a dashed line, `lp: {x,y}` to place
  a stubborn label.

## Adding a diagram

Drop a new `definitions/NN-name.mjs` exporting `{ spec, meta }`. `build.mjs` picks
up every file automatically (ordered by filename) and adds it to the viewer.

## Notes

- PNGs render via `rsvg-convert` if installed, otherwise the `sharp` npm package;
  if neither is present the SVGs/HTML still build and only the PNG step is skipped.
- `validate(spec)` is exported from `lib.mjs`, so the same checks can run in a test
  or a CI gate.
- Diagram **content** is sourced from `docs/architecture-overview.md`,
  `docs/network-security-topology.md`, and `cdk/lib/*` — keep those authoritative;
  these files are the picture, not the source of truth.

# `@haneoka/vega-plugin-cubism`

Cubism 2/3/4/5 character support for Vega.

- Standard `.model.json`, `.moc` and `.model3.json` sources
- A–I–U–E–O visemes and optional MotionSync
- Host-provided runtime adapters
- Resource preloading, caching, cancellation, and disposal

```sh
pnpm add @haneoka/vega @haneoka/vega-plugin-cubism
```

```ts
import { VegaEngine } from "@haneoka/vega";
import {
  createCubismPlugin,
  type CubismRuntimeAdapter,
} from "@haneoka/vega-plugin-cubism";

const adapter: CubismRuntimeAdapter = hostProvidedCubismAdapter;

const engine = new VegaEngine({
  plugins: [createCubismPlugin({ adapter })],
});
```

Ordinary Cubism files need no private fields:

```ts
{ runtime: { model: "/models/hero/hero.model3.json" } }
{ runtime: { model: "/models/legacy/hero.model.json" } }
{ runtime: { moc: "/models/legacy/hero.moc", textures: ["/models/legacy/hero.png"] } }
```

Direct `.moc` sources may provide their standard sidecar files:

```ts
{
  runtime: {
    moc: "/models/legacy/hero.moc",
    textures: ["/models/legacy/hero.png"],
    motions: [{ name: "idle", runtime: "/models/legacy/idle.mtn" }],
    expressions: [{ name: "smile", runtime: "/models/legacy/smile.exp.json" }],
  },
}
```

The host adapter supplies Framework/Core and rendering. `model.cubismLipSync`
accepts audio features or explicit viseme frames.

## Runtime files

The package does not include Cubism SDK/Core or model assets. Applications
provide them at build time or runtime under their applicable licenses.

## License

See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).

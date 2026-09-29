# `@haneoka/vega-plugin-cubism`

`@haneoka/vega-plugin-cubism` connects Cubism 2 and Model3-family models
(Cubism 3, 4, and 5) to Vega. It discovers model manifests, enumerates only the
motions and expressions used by a story, creates renderer-aware models, owns
model lifecycle, and exposes portable AIUEO lip-sync frames.

The application supplies the Cubism Core/runtime adapter and the model assets.
This package provides the Vega adapter boundary and web runtime integration; it
does not redistribute Live2D Cubism Core or proprietary model files.

## Build from a clean Git workspace

The plugin consumes unpublished Vega and Three renderer peers. Clone all three
repositories into one workspace:

```sh
mkdir vega-cubism-workspace
cd vega-cubism-workspace
git clone https://github.com/haneoka-gakuen/vega.git packages/vega
git clone https://github.com/haneoka-gakuen/vega-renderer-three.git packages/vega-renderer-three
git clone https://github.com/haneoka-gakuen/vega-plugin-cubism.git packages/vega-plugin-cubism
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/vega
  - packages/vega/packages/*
  - packages/vega-renderer-three
  - packages/vega-plugin-cubism
linkWorkspacePackages: true
```

Install and build:

```sh
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install
pnpm --filter @haneoka/vega build:core
pnpm --filter @haneoka/vega-renderer-three build
pnpm --filter @haneoka/vega-plugin-cubism check
```

The package requires Node 20 or newer, WebGL2 for the web renderer, and a
separately licensed Cubism Core runtime. The default web runtime URLs are
`/Core/live2dcubismcore.js` for Model3 and `/Core/live2d.min.js` for Cubism 2.

## Vega integration

Configure the runtime adapter, install it with the Three renderer, and describe
a model in the story command. The adapter lazy-loads Core from the configured
URLs and the renderer supplies its WebGL2 context:

```ts
import { VegaEngine } from "@haneoka/vega/engine";
import { VEGA_ADV_OPCODE } from "@haneoka/vega-protocol/opcodes";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";
import {
  createCubismPlugin
} from "@haneoka/vega-plugin-cubism";
import { createCubismWebRuntimeAdapter } from "@haneoka/vega-plugin-cubism/web-runtime";

const mount = document.querySelector<HTMLElement>("#player");
if (!mount) throw new Error("Add <div id=\"player\"></div> to the page");

const adapter = createCubismWebRuntimeAdapter({
  runtime: {
    cubismCoreUrl: "/runtime/live2dcubismcore.js",
    cubism2CoreUrl: "/runtime/live2d.min.js"
  }
});
const engine = new VegaEngine({
  plugins: [
    createThreeRendererPlugin(),
    createCubismPlugin({ adapter })
  ]
});
const handle = await engine.createPlayer({
  mount,
  story: {
    commands: [
      {
        command: VEGA_ADV_OPCODE.In,
        targetName: "hero",
        positionType: 5,
        characterModel: {
          runtime: {
            model: "/models/hero/hero.model3.json"
          }
        },
        noWait: true
      },
      {
        command: VEGA_ADV_OPCODE.Talk,
        targetName: "hero",
        text: "Cubism is now the character provider.",
        noWait: true
      }
    ]
  }
});

await handle.player.play();
await handle.dispose();
await engine.dispose();
```

Vega calls the plugin's `describeCubismModel()` and
`enumerateCubismResources()` during story preparation. A Model3 manifest then
drives its own MOC, textures, physics, pose, user-data, and selected animation
files. A direct Cubism 2 MOC uses the explicit `textures`, `physics`, `motions`,
and `expressions` fields in the character entry. The host resource resolver
must serve every returned URL.

## Lip sync and customization

The plugin creates a model-scoped `CubismLipSyncController`. Push audio
features or a portable viseme frame when the host owns the analyzer:

```ts
import { estimateCubismViseme, getCubismLipSyncController } from "@haneoka/vega-plugin-cubism";

const controller = getCubismLipSyncController(model);
const frame = estimateCubismViseme({ rms: 0.22, low: 0.18, mid: 0.34, high: 0.12 });
controller?.inputViseme(frame, 1 / 60);
```

For model-specific parameter ids, pass `lipSync.parameterProfile` or implement
the adapter hooks `getMouthParameterProfile()` and `applyLipSync()`. A
`createAudioProvider()` callback receives a model-scoped context and its
returned provider is disposed with the model. The plugin reads audio state; it
does not acquire a microphone or own capture permissions.

## Standalone model viewer

The web-runtime viewer exposes the same model implementation without a Vega
story. It is useful for a model browser or asset verification page:

```ts
import { CubismModelViewer } from "@haneoka/vega-plugin-cubism/web-runtime/viewer";

const canvas = document.querySelector<HTMLCanvasElement>("#model");
if (!canvas) throw new Error("Add <canvas id=\"model\"></canvas>");

const viewer = new CubismModelViewer({
  canvas,
  frameControl: "automatic",
  onError: (error) => console.error("Cubism viewer", error)
});
await viewer.load({
  modelUrl: "/models/hero/hero.model3.json",
  defaultMotionName: "Idle",
  autoIdleMotion: true,
  physics: true
});
viewer.setTransform({ scale: 1 });
viewer.setBackgroundColor({ r: 0.04, g: 0.05, b: 0.1 });

// When the page is torn down:
viewer.destroy();
```

`CubismModelViewer.load()` produces the model output; `motionNames`,
`expressionNames`, `parameters()`, `playMotion()`, `playMotionAt()`,
`setLookAtClientPosition()`, and `captureSupersampled()` are the public viewer
controls. `destroy()` releases Core model resources, WebGL shader state, and
the animation loop.

## Lifetime and licenses

Vega owns provider instances inside the player lifetime. Dispose the player
handle before replacing a story; the plugin releases model resources and any
renderer-owned model that finishes after an aborted request. Dispose the engine
after the host removes its renderer.

The adapter requires a separately licensed Live2D Cubism Core/runtime. Preserve
[LICENSE](LICENSE), [CUBISM-LICENSE.md](CUBISM-LICENSE.md), and
[NOTICE.md](NOTICE.md). Model files, textures, motions, and expressions retain
the licenses granted by their authors.

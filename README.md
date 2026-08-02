# `@haneoka/vega-plugin-cubism`

Cubism 2/3/4/5 character support for Vega, including WebGL rendering, model
lifecycle, caching, and AIUEO lip sync.

```sh
pnpm add @haneoka/vega @haneoka/vega-plugin-cubism
```

```ts
import { createCubismPlugin } from "@haneoka/vega-plugin-cubism";
import { createCubismWebRuntimeAdapter } from "@haneoka/vega-plugin-cubism/web-runtime";

const adapter = createCubismWebRuntimeAdapter();
const plugin = createCubismPlugin({ adapter });
```

Core files and model assets are supplied by the application.

Licenses: [`LICENSE`](LICENSE), [`CUBISM-LICENSE.md`](CUBISM-LICENSE.md).

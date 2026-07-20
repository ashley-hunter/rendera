import baseConfig from "../../eslint.config.mjs";

export default [
    ...baseConfig,
    {
        // The core kernel is framework- and platform-agnostic: no DOM, no GPU,
        // no browser globals. Rendering, input, and device access belong in
        // backend/wrapper packages. Enforce that mechanically.
        files: ["**/*.ts"],
        rules: {
            "no-restricted-globals": [
                "error",
                { name: "window", message: "core must stay DOM-free; access the platform from a backend/wrapper package." },
                { name: "document", message: "core must stay DOM-free; access the platform from a backend/wrapper package." },
                { name: "navigator", message: "core must stay platform-agnostic (navigator.gpu belongs in @rendera/webgpu)." },
                { name: "location", message: "core must stay DOM-free." },
                { name: "history", message: "core must stay DOM-free." },
                { name: "self", message: "core must stay DOM/worker-free." },
                { name: "localStorage", message: "core must not do platform I/O." },
                { name: "sessionStorage", message: "core must not do platform I/O." },
                { name: "indexedDB", message: "core must not do platform I/O." },
                { name: "fetch", message: "core must not do network I/O." },
                { name: "XMLHttpRequest", message: "core must not do network I/O." },
                { name: "requestAnimationFrame", message: "scheduling belongs in a backend/wrapper package." },
                { name: "cancelAnimationFrame", message: "scheduling belongs in a backend/wrapper package." }
            ]
        }
    },
    {
        files: [
            "**/*.json"
        ],
        rules: {
      "@nx/dependency-checks": [
        "error",
        {
          "ignoredFiles": [
            "{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}",
            "{projectRoot}/vite.config.{js,ts,mjs,mts}"
          ],
          // harfbuzzjs is loaded via a lazy dynamic `import()` (so the wasm only
          // costs consumers who use text) and unicode-properties is reached
          // through a typed shim — neither is visible to the static dep graph.
          "ignoredDependencies": ["harfbuzzjs", "unicode-properties"]
        }
      ]
    },
        languageOptions: {
            parser: await import("jsonc-eslint-parser")
        }
    }
];

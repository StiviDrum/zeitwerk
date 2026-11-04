/**
 * Deferred custom element registration.
 *
 * Home Assistant loads integration modules (`add_extra_js_url`) in parallel
 * with its own app bundle, which installs a scoped custom element registry
 * polyfill and replaces `window.customElements`. Elements defined before that
 * swap end up in the old registry and HA reports "Custom element not found".
 * So inside Home Assistant we wait until HA itself has defined
 * `home-assistant` (the new registry is active then) before defining ours.
 */

export interface RegistryHost {
  customElements: Pick<CustomElementRegistry, "get" | "define" | "whenDefined">;
  document: { querySelector(selector: string): unknown };
}

export function defineElements(
  elements: [string, CustomElementConstructor][],
  host: RegistryHost = window,
): Promise<void> {
  const run = () => {
    // Read the registry at call time: it may have been replaced meanwhile.
    for (const [name, ctor] of elements) {
      if (!host.customElements.get(name)) host.customElements.define(name, ctor);
    }
  };
  const insideHa = !!host.document.querySelector("home-assistant");
  if (!insideHa || host.customElements.get("home-assistant")) {
    run();
    return Promise.resolve();
  }
  return host.customElements.whenDefined("home-assistant").then(run);
}

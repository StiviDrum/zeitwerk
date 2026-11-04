import { describe, expect, it } from "vitest";
import { defineElements, type RegistryHost } from "../src/register";

class FakeRegistry {
  defs = new Map<string, unknown>();
  waiters = new Map<string, (() => void)[]>();
  get = (name: string) => this.defs.get(name) as CustomElementConstructor | undefined;
  define = (name: string, ctor: CustomElementConstructor) => {
    if (this.defs.has(name)) throw new Error(`${name} already defined`);
    this.defs.set(name, ctor);
    (this.waiters.get(name) ?? []).forEach((r) => r());
  };
  whenDefined = (name: string) =>
    new Promise<CustomElementConstructor>((resolve) => {
      if (this.defs.has(name)) resolve(this.defs.get(name) as CustomElementConstructor);
      else
        this.waiters.set(name, [
          ...(this.waiters.get(name) ?? []),
          () => resolve(this.defs.get(name) as CustomElementConstructor),
        ]);
    });
}

const Ctor = class {} as unknown as CustomElementConstructor;

describe("defineElements", () => {
  it("defines immediately outside Home Assistant", async () => {
    const reg = new FakeRegistry();
    const host = {
      customElements: reg,
      document: { querySelector: () => null },
    } as unknown as RegistryHost;
    await defineElements([["zeitwerk-card", Ctor]], host);
    expect(reg.get("zeitwerk-card")).toBe(Ctor);
  });

  it("waits for HA and defines in the registry that is active then", async () => {
    const native = new FakeRegistry();
    const host = {
      customElements: native as FakeRegistry,
      document: { querySelector: (s: string) => (s === "home-assistant" ? {} : null) },
    } as unknown as RegistryHost & { customElements: FakeRegistry };
    const done = defineElements([["zeitwerk-card", Ctor]], host);
    expect(native.get("zeitwerk-card")).toBeUndefined();
    // HA's app bundle swaps the registry, then defines home-assistant (also natively)
    const scoped = new FakeRegistry();
    host.customElements = scoped;
    scoped.define("home-assistant", Ctor);
    native.define("home-assistant", Ctor);
    await done;
    expect(scoped.get("zeitwerk-card")).toBe(Ctor);
    expect(native.get("zeitwerk-card")).toBeUndefined();
  });

  it("defines right away when HA is already up and skips duplicates", async () => {
    const reg = new FakeRegistry();
    reg.define("home-assistant", Ctor);
    reg.define("zeitwerk-card", Ctor);
    const host = {
      customElements: reg,
      document: { querySelector: () => ({}) },
    } as unknown as RegistryHost;
    await defineElements(
      [
        ["zeitwerk-card", Ctor],
        ["zeitwerk-rules", Ctor],
      ],
      host,
    );
    expect(reg.get("zeitwerk-rules")).toBe(Ctor);
  });
});

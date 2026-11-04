declare const __VERSION__: string;
export const CARD_VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

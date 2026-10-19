declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  /**
   * assembly/index/spin
   * @param angle `f32`
   * @param dt `f32`
   * @param speed `f32`
   * @returns `f32`
   */
  export function spin(angle: number, dt: number, speed: number): number;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
}): Promise<typeof __AdaptedExports>;

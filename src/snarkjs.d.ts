declare module "snarkjs" {
  export const zKey: {
    contribute: (
      input: string,
      output: string,
      name: string,
      entropy: string,
    ) => Promise<unknown>;
  };
}

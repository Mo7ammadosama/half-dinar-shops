// react-test-renderer ships no types and has no @types package for v19.
// This minimal declaration covers the two calls the native smoke test uses.
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface ReactTestRenderer {
    toJSON(): unknown;
    unmount(): void;
  }

  export function create(element: ReactElement): ReactTestRenderer;
  export function act(callback: () => void | Promise<void>): Promise<void>;
}

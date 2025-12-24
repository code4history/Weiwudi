# Design: Strict Typing Strategy

## Approach

We will transition from "File-level Ignore" to "Granular Ignore" and then to "Strict Types".

1.  **Remove Global Ignore**: Remove `// @ts-nocheck` from `weiwudi_gw_logic.ts`.
2.  **Apply Granular Suppressions**: run compilation and apply `// @ts-ignore` or `any` explicitly to failing lines/scopes only.
3.  **Iterative Fixing**: Pick specific functions or logic blocks to type strictly, removing suppressions one by one.

## `weiwudi_gw_logic.ts` Challenges

This file contains dynamic object manipulation and jQuery-like patterns.
- **Strategy**: Define interface `WeiwudiInternalOps` that describes the expected shape of the internal object.
- **Initial Step**: Type the `Weiwudi_Internal` function signature and basic variables.
- **Incremental**: Leave complex jQuery-style parts as `any` or ignored initially, focus on logic correctness first.

## Fallback
If specific legacy patterns are impossible to type strictly without major rewrite, we will use scoped `// @ts-expect-error` with explanation comments, rather than file-wide `nocheck`.

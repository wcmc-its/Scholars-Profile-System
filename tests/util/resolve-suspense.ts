/**
 * Awaits the async server components a page streams under `<Suspense>`, so a
 * test that walks the returned element tree sees what the browser gets once
 * the boundary resolves. Only a Suspense boundary's async children are
 * resolved; every other element (a mocked `ReportHeader`, say) is left as-is
 * for `findByType` to match.
 *
 * Lives under `tests/util/`, outside the `tests/unit/**` spec glob.
 */
import * as React from "react";

type El = { type: unknown; props: { children?: unknown } & Record<string, unknown> };

function isElement(node: unknown): node is El {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function isAsyncComponent(node: unknown): node is El & { type: (props: unknown) => Promise<unknown> } {
  return isElement(node) && typeof node.type === "function" && node.type.constructor.name === "AsyncFunction";
}

export async function resolveSuspense(node: unknown, inSuspense = false): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolveSuspense(n, inSuspense)));
  if (!isElement(node)) return node;
  if (inSuspense && isAsyncComponent(node)) return resolveSuspense(await node.type(node.props), true);
  const children = node.props.children;
  if (children === undefined) return node;
  return {
    ...node,
    props: { ...node.props, children: await resolveSuspense(children, inSuspense || node.type === React.Suspense) },
  };
}

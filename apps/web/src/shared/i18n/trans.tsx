import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { lookup } from './index.ts';
import { getLocale } from './locale.ts';

/** `{placeholder}` token shape, identical to the one `t()`/`tr()` use. */
const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Translate a source string while interpolating React nodes into its
 * `{placeholder}` tokens — for copy that originally carried inline markup
 * (`<b>`, `<span>`) around a value, which plain `t()` flattens to text.
 *
 * Locale resolution mirrors `t()`: `en` renders the source template, otherwise
 * the raw dictionary value is used (`lookup()`, no locale gating) with the
 * source as fallback. A token with no matching var renders as its literal
 * `{name}` text; string/number vars are fine alongside nodes.
 *
 * @example
 *   tNode('{name} offers {amount} to peek.', {
 *     name: <b>{o.fromName}</b>,
 *     amount: <b className="font-display">{fmt(o.amount)}</b>,
 *   })
 */
export function tNode(source: string, vars: Record<string, ReactNode>): ReactNode {
  if (typeof source !== 'string' || source.length === 0) return source;
  const template = getLocale() === 'en' ? source : (lookup(source) ?? source);

  const children: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of template.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) children.push(template.slice(last, at));
    const name = match[1] ?? '';
    const node = vars[name];
    if (node === undefined) {
      // Missing var: keep the raw token visible, same fallback as `t()`.
      children.push(match[0]);
    } else {
      // Keyed fragment so any node shape (string, number, element) nests safely.
      children.push(<Fragment key={`v${i}`}>{node}</Fragment>);
    }
    last = at + match[0].length;
    i += 1;
  }
  if (last < template.length) children.push(template.slice(last));
  return <Fragment>{children}</Fragment>;
}

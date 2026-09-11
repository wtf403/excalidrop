/** Fetch an `.excalidrawlib` doc and return its library items. */
export async function fetchLibraryItems(url: string): Promise<unknown[]> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`library fetch ${r.status}`);
  const j = await r.json();
  // excalidrawlib shape: { type: 'excalidrawlib', libraryItems: [...] }
  // Some endpoints wrap it: { library: [...] } or a bare array.
  const items = Array.isArray(j)
    ? j
    : Array.isArray((j as any)?.libraryItems)
      ? (j as any).libraryItems
      : Array.isArray((j as any)?.library)
        ? (j as any).library
        : null;
  if (!items) throw new Error('not an excalidrawlib file');
  return items;
}

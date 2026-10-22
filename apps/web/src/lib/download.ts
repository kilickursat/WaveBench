export function download(name: string, data: Blob | string, type = "text/csv"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: `${type};charset=utf-8` }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** File-name stem from a data source name. */
export function stem(name: string): string {
  return (name.replace(/\.[^.]+$/, "") || "wavebench").replace(/[^\w.-]+/g, "_").slice(0, 60);
}

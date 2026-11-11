import http from "node:http";

export async function getStatusWithFetch(url: string): Promise<number> {
  const res = await fetch(url);
  await res.arrayBuffer();
  return res.status;
}

export function getStatusWithHttp(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

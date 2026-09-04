import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../src/server/http-app.js";

const bridge = {
  diagnostics: async () => ({ mortiphiVersion:"test",museVersion:"test",sdkVersion:"0.1.1",schemaVersion:1,schemaFingerprint:"x",expectedFingerprint:"x",fingerprintDrift:false,durability:"durable",platform:"test",connected:true,grantedCapabilities:[],unsupported:[] }),
  listSessions: async () => ({ sessions: [], nextCursor: null }),
  models: async () => ({ models: [] }),
  renameTask: async (sessionId: string, title: string) => ({ sessionId, title, titleSource: "mortiphi" }),
  removeLocal: async (sessionId: string) => ({ sessionId, removedFrom: "mortiphi", museSessionPreserved: true }),
} as any;
let server: any;
afterEach(() => server?.close());

function call(port: number, path: string, options: { method?: string; host?: string; origin?: string; cookie?: string; csrf?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: any; body: any }>((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { Host: options.host ?? "127.0.0.1:0", ...(options.origin ? { Origin: options.origin } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}), ...(body ? { "Content-Type":"application/json", "Content-Length":Buffer.byteLength(body) } : {}) } }, (res) => {
      let text=""; res.on("data",(c)=>text+=c); res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text||"{}")}));
    }); req.on("error",reject); if(body) req.end(body); else req.end();
  });
}

describe("HTTP security boundary", () => {
  it("sets no CORS, rejects foreign hosts/origins, and requires cookie plus CSRF", async () => {
    const app = createHttpApp(bridge, undefined, 0); server = app.listen(0, "127.0.0.1"); await new Promise((r)=>server.once("listening",r)); const port=server.address().port;
    const foreignHost = await call(port,"/api/bootstrap",{host:"evil.example"}); expect(foreignHost.status).toBe(403);
    const foreignOrigin = await call(port,"/api/bootstrap",{origin:"https://evil.example"}); expect(foreignOrigin.status).toBe(403);
    const boot = await call(port,"/api/bootstrap"); expect(boot.status).toBe(200); expect(boot.headers["access-control-allow-origin"]).toBeUndefined(); expect(boot.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    const cookie=String(boot.headers["set-cookie"][0]).split(";")[0];
    expect((await call(port,"/api/sessions",{cookie})).status).toBe(200);
    expect((await call(port,"/api/workspaces/open",{method:"POST",cookie,body:{path:"/tmp"}})).status).toBe(403);
    expect((await call(port,"/api/workspaces/open",{method:"POST",cookie,csrf:boot.body.csrfToken,body:{path:"relative"}})).body.code).toBe("workspace_not_absolute");
    const renamed = await call(port,"/api/sessions/fork-1/label",{method:"PATCH",cookie,csrf:boot.body.csrfToken,body:{title:"Alternate plan"}});
    expect(renamed.body).toMatchObject({sessionId:"fork-1",title:"Alternate plan",titleSource:"mortiphi"});
    const removed = await call(port,"/api/sessions/task-1",{method:"DELETE",cookie,csrf:boot.body.csrfToken});
    expect(removed.body).toMatchObject({sessionId:"task-1",removedFrom:"mortiphi",museSessionPreserved:true});
  });
});

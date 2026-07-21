import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { ApiClient } from "./api/client";
import { App } from "./app/App";
import { AuthService } from "./auth/auth-service";
import { WorkerVault } from "./auth/vault-client";
import "./styles.css";

registerSW({ immediate: true });

const vault = new WorkerVault();
let auth: AuthService;
const api = new ApiClient({ onSessionExpired: () => void auth.expireSession() });
auth = new AuthService(api, vault);

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Application root is missing.");
await auth.restoreSession();
createRoot(root).render(<App auth={auth} />);

window.addEventListener("pagehide", () => vault.terminate(), { once: true });

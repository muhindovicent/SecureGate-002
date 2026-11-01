import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
  const apiBase = (env.VITE_API_URL || "/api/v1").trim().replace(/\/$/, "");
  if (apiBase !== "/api/v1")
    throw new Error(
      "VITE_API_URL must be /api/v1. Vercel forwards /api to Render; browser requests must stay same-origin.",
    );
  return {
    define: { "import.meta.env.VITE_API_URL": JSON.stringify(apiBase) },
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(process.env.WEB_PORT || 5173),
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${process.env.PORT || 3000}`,
          changeOrigin: false,
        },
      },
    },
  };
});

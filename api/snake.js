const https = require("https");

const owner = "S0x2-dev";
const repo = "S0x2-dev";
const branch = "output";

function fetchRepoFile(path, token) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "api.github.com",
                path: `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`,
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github.raw",
                    "User-Agent": "snake-proxy",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                    else reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

module.exports = async (req, res) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        res.status(500).send("GITHUB_TOKEN not set");
        return;
    }

    const palette = (req.query?.palette || req.query?.theme || "").toLowerCase();
    const file = palette === "dark" ? "github-snake-dark.svg" : "github-snake.svg";

    try {
        const svg = await fetchRepoFile(file, token);
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
        res.status(200).send(svg);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching snake");
    }
};

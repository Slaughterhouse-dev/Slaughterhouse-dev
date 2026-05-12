const https = require("https");
const fs = require("fs");

const Usermame = "Slaughterhouse-dev";
const Token = process.env.GITHUB_TOKEN;

const style = {
    bg: "#171517",
    bgCard: "#1d1b1d",
    border: "#212022",
    accent: "#91a1f1",
    accentShade: "#798be6",
    text: "#c8c8c8",
    muted: "#8c8c8c",
};

function gql(query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
                hostname: "api.github.com",
                path: "/graphql",
                method: "POST",
                headers: {
                    Authorization: `Bearer ${Token}`,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "User-Agent": "profile-card-generator",
                },
            }, (res) => {
                let raw = "";
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    try { 
                        resolve(JSON.parse(raw));
                    }
                    catch (e) { 
                        reject(e); 
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function fetchData() {
    const { data } = await gql(
        `query($login: String!) {
      user(login: $login) {
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
          nodes {
            stargazerCount
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name color } }
            }
          }
        }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays { contributionCount date }
            }
          }
        }
        repositoriesContributedTo(
          first: 1
          contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
        ) { totalCount }
      }
    }`, { 
        login: Usermame 
    });
    return data.user;
}

function calcStreak(weeks) {
    const days = weeks.flatMap((w) => w.contributionDays).sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = new Date().toISOString().slice(0, 10);

    let current = 0, startCurrent = "", endCurrent = "";
    for (const d of days) {
        if (d.date > today) continue;
        if (current === 0 && d.contributionCount === 0 && d.date !== today) break;
        if (d.contributionCount > 0) {
            current++;
            if (!endCurrent) endCurrent = d.date;
            startCurrent = d.date;
        } else if (d.date !== today) break;
    }

    let longest = 0, temp = 0;
    for (const d of [...days].reverse()) {
        temp = d.contributionCount > 0 ? temp + 1 : 0;
        if (temp > longest) longest = temp;
    }

    return { current, longest, startCurrent, endCurrent };
}

function topLangs(repos) {
    const map = {};
    let total = 0;
    for (const repo of repos) {
        for (const { size, node } of repo.languages.edges) {
            if (!map[node.name]) map[node.name] = {
                size: 0,
                color: node.color || style.muted 
            };
            map[node.name].size += size;
            total += size;
        }
    }
    return Object.entries(map).sort((a, b) => b[1].size - a[1].size).slice(0, 6).map(([name, { size, color }]) => ({
        name,
        color,
        pct: ((size / total) * 100).toFixed(1),
    }));
}

function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtNum(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function donut(langs) {
    const cx = 636, cy = 110, r = 48;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const segs = langs.map(({ color, pct }) => {
        const dash = (pct / 100) * circ;
        const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${color}" stroke-width="16"
            stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}"
            transform="rotate(-90 ${cx} ${cy})"/>`;
        offset += dash;
        return seg;
    });
    return segs.join("\n    ") + `\n    <circle cx="${cx}" cy="${cy}" r="30" fill="${style.bgCard}"/>`;
}

function langLegend(langs) {
    return langs.map(({ name, color, pct }, i) => {
        const y = 34 + i * 24;
        return `
        <circle cx="492" cy="${y - 5}" r="5" fill="${color}"/>
        <text x="504" y="${y}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${style.text}">${name}</text>
        <text x="742" y="${y}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${style.muted}" text-anchor="end">${pct}%</text>`;
    }).join("");
}

function generateSVG(user, streak, langs, stars) {
    const cc = user.contributionsCollection;
    const total = cc.contributionCalendar.totalContributions;

    return `<svg width="760" height="330" viewBox="0 0 760 330"
        xmlns="http://www.w3.org/2000/svg" role="img">
        <title>Slaughterhouse-dev GitHub Stats</title>

        <rect width="760" height="330" rx="10" fill="${style.bg}" stroke="${style.border}" stroke-width="1"/>

        <rect x="16" y="16" width="454" height="188" rx="8" fill="${style.bgCard}" stroke="${style.border}" stroke-width="0.5"/>
        <text x="32" y="44" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="14" font-weight="600" fill="${style.accent}">Slaughterhouse's GitHub Stats</text>

        <text x="32"  y="78"  font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.muted}">Total Stars Earned:</text>
        <text x="270" y="78"  font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.text}">${stars}</text>

        <text x="32"  y="102" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.muted}">Total Commits (last year):</text>
        <text x="270" y="102" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.text}">${fmtNum(cc.totalCommitContributions)}</text>

        <text x="32"  y="126" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.muted}">Total PRs:</text>
        <text x="270" y="126" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.text}">${cc.totalPullRequestContributions}</text>

        <text x="32"  y="150" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.muted}">Total Issues:</text>
        <text x="270" y="150" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.text}">${cc.totalIssueContributions}</text>

        <text x="32"  y="174" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.muted}">Contributed to:</text>
        <text x="270" y="174" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${style.text}">${user.repositoriesContributedTo.totalCount}</text>

        <circle cx="408" cy="112" r="38" fill="none" stroke="${style.border}" stroke-width="3"/>
        <circle cx="408" cy="112" r="38" fill="none" stroke="${style.accent}" stroke-width="3" stroke-dasharray="190 50" stroke-dashoffset="47" transform="rotate(-90 408 112)"/>
        <text x="408" y="119" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="17" font-weight="700" fill="${style.text}" text-anchor="middle">A+</text>

        <rect x="482" y="16" width="262" height="188" rx="8" fill="${style.bgCard}" stroke="${style.border}" stroke-width="0.5"/>
        <text x="492" y="22" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="${style.accent}" dominant-baseline="hanging">Most Used Languages</text>
        ${langLegend(langs)}
        ${donut(langs)}

        <rect x="16" y="220" width="728" height="94" rx="8" fill="${style.bgCard}" stroke="${style.border}" stroke-width="0.5"/>

        <text x="192" y="254" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="700" fill="${style.text}" text-anchor="middle">${total.toLocaleString()}</text>
        <text x="192" y="273" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${style.muted}" text-anchor="middle">Total Contributions</text>
        <text x="192" y="290" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="10" fill="${style.muted}" text-anchor="middle">Apr 30, 2024 - Present</text>

        <line x1="368" y1="232" x2="368" y2="302" stroke="${style.border}" stroke-width="0.5"/>
        <line x1="558" y1="232" x2="558" y2="302" stroke="${style.border}" stroke-width="0.5"/>

        <text x="464" y="254" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="700" fill="${style.text}" text-anchor="middle">${streak.current}</text>
        <text x="464" y="273" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${style.accent}" text-anchor="middle">Current Streak</text>
        <text x="464" y="290" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="10" fill="${style.muted}" text-anchor="middle">${fmtDate(streak.startCurrent)} - ${fmtDate(streak.endCurrent)}</text>

        <text x="654" y="254" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="700" fill="${style.text}" text-anchor="middle">${streak.longest}</text>
        <text x="654" y="273" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${style.muted}" text-anchor="middle">Longest Streak</text>
    </svg>`;
}

(async () => {
    console.log("Fetching GitHub data...");
    const user = await fetchData();
    const langs = topLangs(user.repositories.nodes);
    const streak = calcStreak(user.contributionsCollection.contributionCalendar.weeks);
    const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);

    const svg = generateSVG(user, streak, langs, stars);
    fs.writeFileSync("profile-card.svg", svg);
    console.log("Good: profile-card.svg saved");
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
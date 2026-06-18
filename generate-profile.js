const https = require("https");
const fs = require("fs");

const username = "S0x2-dev";
const token = process.env.GITHUB_TOKEN;
const spotifyUserId = "31leep2d5rpspzgszzi6glolhul4";

const theme = {
    background: "#171517",
    cardBackground: "#1d1b1d",
    border: "#212022",
    accent: "#91a1f1",
    text: "#c8c8c8",
    muted: "#8c8c8c",
    font: `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"`,
};

function executeGraphQL(query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const options = {
            hostname: "api.github.com",
            path: "/graphql",
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent": "profile-card-generator",
            },
        };

        const request = https.request(options, (response) => {
            let data = "";
            response.on("data", (chunk) => (data += chunk));
            response.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.on("error", reject);
        request.write(body);
        request.end();
    });
}

function fetchSpotifyData() {
    return new Promise((resolve) => {
        const options = {
            hostname: "spotify-github-profile.kittinanx.com",
            path: `/api/view?uid=${spotifyUserId}`,
            method: "GET",
            headers: { "User-Agent": "profile-card-generator" },
        };

        const request = https.request(options, (response) => {
            let data = "";
            response.on("data", (chunk) => (data += chunk));
            response.on("end", () => {
                try {
                    const trackMatch = data.match(/<h2[^>]*>([^<]+)<\/h2>/);
                    const trackName = trackMatch ? trackMatch[1].trim() : null;
                    const colorMatch = data.match(/style="[^"]*background.*?([#a-f0-9]{6})/i);
                    const trackColor = colorMatch ? "#" + colorMatch[1] : theme.accent;
                    resolve({ 
                        trackName, 
                        trackColor, 
                        isPlaying: !!trackName 
                    });
                } catch (error) {
                    resolve({ 
                        trackName: null, 
                        trackColor: theme.accent, 
                        isPlaying: false 
                    });
                }
            });
        });

        request.on("error", () => {
            resolve({ trackName: null, trackColor: theme.accent, isPlaying: false });
        });

        request.write("");
        request.end();
    });
}

function readProfileViews() {
    try {
        const viewCount = parseInt(fs.readFileSync("profile-views.txt", "utf8").trim()) || 0;
        return viewCount;
    } catch (error) {
        return 0;
    }
}

async function fetchGitHubData() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const previousYear = currentYear - 1;

    const yearFragments = [{ year: currentYear,  key: "current" }, { year: previousYear, key: "previous" }].map(({ year, key }) => ` ${key}: contributionsCollection(from: "${year}-01-01T00:00:00Z"to: "${year}-12-31T23:59:59Z") {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          restrictedContributionsCount
        }
    `,
    ).join("");

    const { data } = await executeGraphQL(`
        query($login: String!) {
          user(login: $login) {
            repositories(ownerAffiliations: OWNER, first: 100) {
              nodes {
                stargazerCount
                languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                  edges {
                    size node { name color }
                  }
                }
              }
            }
            contributionsCollection {
              contributionCalendar {
                totalContributions
                weeks {
                  contributionDays { contributionCount date }
                }
              }
            }
            ${yearFragments}
            followers { totalCount }
            repositoriesContributedTo(
              first: 1
              contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
            ) { totalCount }
          }
        }
    `, { 
        login: username 
    });
    return data.user;
}

function calculateStreak(weeks) {
    const allDays = weeks.flatMap((week) => week.contributionDays).sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = new Date().toISOString().slice(0, 10);

    let currentStreakCount = 0;
    let currentStreakStart = "";
    let currentStreakEnd = "";

    for (const day of allDays) {
        if (day.date > today) continue;
        if (currentStreakCount === 0 && day.contributionCount === 0 && day.date !== today) break;
        if (day.contributionCount > 0) {
            currentStreakCount++;
            if (!currentStreakEnd) {
                currentStreakEnd = day.date;
            }
            currentStreakStart = day.date;
        } else if (day.date !== today) break;
    }

    let longestStreakCount = 0;
    let tempStreakCount = 0;

    for (const day of [...allDays].reverse()) {
        if (day.contributionCount > 0) {
            tempStreakCount++;
            if (tempStreakCount > longestStreakCount) longestStreakCount = tempStreakCount;
        } else {
            tempStreakCount = 0;
        }
    }

    return {
        current: currentStreakCount,
        longest: longestStreakCount,
        startDate: currentStreakStart,
        endDate: currentStreakEnd,
    };
}

function getTopLanguages(repositories) {
    const languageMap = {};

    for (const repo of repositories) {
        for (const { size, node } of repo.languages.edges) {
            if (!languageMap[node.name]) {
                languageMap[node.name] = { size: 0, color: node.color || theme.muted };
            }
            languageMap[node.name].size += size;
        }
    }

    const topLanguages = Object.entries(languageMap).sort((a, b) => b[1].size - a[1].size).slice(0, 6);
    const totalSize = topLanguages.reduce((sum, [, data]) => sum + data.size, 0);

    return topLanguages.map(([name, { size, color }]) => ({
        name: name.length > 13 ? name.slice(0, 12) + "." : name,
        color,
        percentage: ((size / totalSize) * 100).toFixed(1),
    }));
}

function formatDate(isoDate) {
    if (!isoDate) return "";
    return new Date(isoDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatNumber(number) {
    return number >= 1000 ? (number / 1000).toFixed(1) + "k" : String(number);
}

function calculateRank({ commits, pullRequests, issues, stars, followers }) {
    const exponentialCdf = (x) => 1 - Math.pow(2, -x);
    const normalCdf = (mean, sigma, value) => {
        const z = (value - mean) / Math.sqrt(2 * sigma * sigma);
        const t = 1 / (1 + 0.3275911 * Math.abs(z));
        const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
        return 0.5 * (1 + (z >= 0 ? erf : -erf));
    };

    const score = (2 * exponentialCdf(commits / 250) + 3 * exponentialCdf(pullRequests / 50) + 1 * exponentialCdf(issues / 25) + 4 * exponentialCdf(stars / 50) + 1 * exponentialCdf(followers / 10)) / 11;

    return 100 - 100 * normalCdf(score, 1, 0.75);
}

function createDonutChart(languages, centerX, centerY, radius) {
    const circumference = 2 * Math.PI * radius;
    let offset = 0;

    const segments = languages.map(({ color, percentage }) => {
        const dashLength = (percentage / 100) * circumference;
        const segment = `
            <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none"
            stroke="${color}" stroke-width="10"
            stroke-dasharray="${dashLength.toFixed(2)} ${(circumference - dashLength).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}"
            transform="rotate(-90 ${centerX} ${centerY})"/>
        `;
        offset += dashLength;
        return segment;
    });

    return segments.join("\n") + `\n<circle cx="${centerX}" cy="${centerY}" r="${radius - 14}" fill="${theme.cardBackground}"/>`;
}

function createLanguageLegend(languages, posX, startY, gap) {
    return languages.map(({ name, color, percentage }, index) => {
        const y = startY + index * gap;
        return `
            <circle cx="${posX}" cy="${y - 4}" r="4" fill="${color}"/>
            <text x="${posX + 11}" y="${y}" ${theme.font} font-size="12" fill="${theme.text}">${name} <tspan fill="${theme.muted}">${percentage}%</tspan></text>
        `;
    }).join("");
}

function createFlame(centerX, centerY, size, color, ringStroke) {
    const scale = size / 24;
    const translateX = centerX - 12 * scale;
    const translateY = centerY - 12 * scale;
    const strokeWidth = (ringStroke / scale).toFixed(2);

    return `
    <g transform="translate(${translateX} ${translateY}) scale(${scale})">
        <path d="M 19.48 12.35 c -1.57 -4.08 -7.16 -4.3 -5.81 -10.23 c .1 -.44 -.37 -.78 -.75 -.55 C 9.29 3.71 6.68 8 8.87 13.62 c .18 .46 -.36 .89 -.75 .59 c -1.81 -1.37 -2 -3.34 -1.84 -4.75 c .06 -.52 -.62 -.77 -.91 -.34 C 4.69 10.16 4 11.84 4 14.37 c .38 5.6 5.11 7.32 6.81 7.54 c 2.43 .31 5.06 -.14 6.95 -1.87 c 2.08 -1.93 2.84 -5.01 1.72 -7.69 z" fill="none"stroke="${color}"stroke-width="${strokeWidth}"stroke-linejoin="round" stroke-linecap="round"/>
    </g>`;
}

function createWaveAnimation(color) {
    const points = [];
    const amplitude = 3;
    const frequency = 0.15;
    const segments = 180;

    for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const baseX = 380 + 150 * Math.cos(angle);
        const baseY = 308 + 150 * Math.sin(angle);
        const offset = amplitude * Math.sin(angle * frequency + Date.now() / 1000);
        const x = baseX + offset * Math.cos(angle);
        const y = baseY + offset * Math.sin(angle);
        points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }

    return `
    <style>
        @keyframes wave {
            0% { 
                transform: rotate(0deg); 
            }
            100% { 
                transform: rotate(360deg);
            }
        }
        .wave-path { 
            animation: wave 20s linear infinite;
            transform-origin: 380px 308px; 
        }
    </style>
    <polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.4" class="wave-path"/>`;
}

function createSpotifyCard(trackName, trackColor, viewCount) {
    const cardX = 32;
    const cardY = 244;
    const viewsX = 690;
    const viewsY = 244;

    if (!trackName) {
        return `
            <text x="${cardX}" y="${cardY}" ${theme.font} font-size="12" fill="${theme.muted}">🎵 Not playing</text>
            <text x="${viewsX}" y="${viewsY}" ${theme.font} font-size="14" font-weight="600" fill="${theme.text}" text-anchor="end">${formatNumber(viewCount)}</text>
            <text x="${viewsX}" y="${viewsY + 16}" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="end">Profile Views</text>
        `;
    }

    return `
        <rect x="${cardX}" y="${cardY - 12}" width="300" height="28" rx="4" fill="${trackColor}22"/>
        <circle cx="${cardX + 8}" cy="${cardY + 2}" r="3" fill="${trackColor}"/>
        <text x="${cardX + 18}" y="${cardY + 6}" ${theme.font} font-size="12" font-weight="600" fill="${theme.text}">${trackName}</text>
        <text x="${viewsX}" y="${viewsY}" ${theme.font} font-size="20" font-weight="700" fill="${theme.text}" text-anchor="end">${formatNumber(viewCount)}</text>
        <text x="${viewsX}" y="${viewsY + 16}" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="end">Profile Views</text>
    `;
}

function generateSVG(userData, streakInfo, languages, starCount, commitCount, prCount, issueCount, rankPercentile, spotify, viewCount) {
    const totalContributions = userData.contributionsCollection.contributionCalendar.totalContributions;

    const rankCircumference = 2 * Math.PI * 38;
    const rankFillLength = (1 - rankPercentile / 100) * rankCircumference;
    const rankGapLength = rankCircumference - rankFillLength;

    const donutChart = createDonutChart(languages, 685, 119, 34);
    const languageLegend = createLanguageLegend(languages, 506, 64, 22);

    const streakCenterX = 380;
    const streakCenterY = 280;
    const streakRadius = 34;
    const streakRingStroke = 2.5;
    const flameSize = 20;
    const flameSVG = createFlame(streakCenterX, streakCenterY - streakRadius - 1, flameSize, theme.accent, streakRingStroke);
    const waveSVG = createWaveAnimation(spotify.trackColor || theme.accent);

    const sideNumberY = 293;
    const sideLabelY = 311;
    const sideDateY = 324;

    return `<svg width="760" height="396" viewBox="0 0 760 396" xmlns="http://www.w3.org/2000/svg" role="img">
    <title>S0x2-dev GitHub Stats</title>

    <defs>
      <mask id="streak-ring-cut">
        <rect width="760" height="396" fill="white"/>
        <rect x="${streakCenterX - 6}" y="${streakCenterY - streakRadius - 2}" width="12" height="5" fill="black"/>
      </mask>
    </defs>

    <rect width="760" height="396" rx="10" fill="${theme.background}" stroke="${theme.border}" stroke-width="1"/>

    <rect x="16" y="16" width="454" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="32" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">S0x2-dev's GitHub Stats</text>

    <text x="32" y="76" ${theme.font} font-size="13" fill="${theme.muted}">Total Stars Earned:</text>
    <text x="260" y="76" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${starCount}</text>

    <text x="32" y="100" ${theme.font} font-size="13" fill="${theme.muted}">Total Commits (last year):</text>
    <text x="260" y="100" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${formatNumber(commitCount)}</text>

    <text x="32" y="124" ${theme.font} font-size="13" fill="${theme.muted}">Total PRs:</text>
    <text x="260" y="124" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${prCount}</text>

    <text x="32" y="148" ${theme.font} font-size="13" fill="${theme.muted}">Total Issues:</text>
    <text x="260" y="148" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${issueCount}</text>

    <text x="32" y="172" ${theme.font} font-size="13" fill="${theme.muted}">Contributed to (last year):</text>
    <text x="260" y="172" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${userData.repositoriesContributedTo.totalCount}</text>

    <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.border}" stroke-width="3"/>
    <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.accent}" stroke-width="3"
      stroke-dasharray="${rankFillLength.toFixed(1)} ${rankGapLength.toFixed(1)}"
      stroke-dashoffset="0"
      transform="rotate(-90 408 112)"/>
    <text x="408" y="118" ${theme.font} font-size="18" font-weight="700" fill="${theme.text}" text-anchor="middle">A+</text>

    <rect x="482" y="16" width="262" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="506" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">Most Used Languages</text>
    ${languageLegend}
    ${donutChart}

    <rect x="16" y="220" width="728" height="160" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>

    <text x="137" y="${sideNumberY}" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${totalContributions.toLocaleString()}</text>
    <text x="137" y="${sideLabelY}" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Total Contributions</text>
    <text x="137" y="${sideDateY}" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">Apr 30, 2024 - Present</text>

    <line x1="259" y1="232" x2="259" y2="372" stroke="${theme.border}" stroke-width="0.5"/>
    <line x1="501" y1="232" x2="501" y2="372" stroke="${theme.border}" stroke-width="0.5"/>

    <circle cx="${streakCenterX}" cy="${streakCenterY}" r="${streakRadius}" fill="none" stroke="${theme.accent}" stroke-width="${streakRingStroke}" mask="url(#streak-ring-cut)"/>
    ${flameSVG}
    ${waveSVG}
    <text x="${streakCenterX}" y="${streakCenterY + 9}" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${streakInfo.current}</text>
    <text x="${streakCenterX}" y="${streakCenterY + streakRadius + 30}" ${theme.font} font-size="17" font-weight="700" fill="${theme.accent}" text-anchor="middle">Current Streak</text>
    <text x="${streakCenterX}" y="${streakCenterY + streakRadius + 48}" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">${formatDate(streakInfo.startDate)} - ${formatDate(streakInfo.endDate)}</text>

    <text x="621" y="${sideNumberY}" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${streakInfo.longest}</text>
    <text x="621" y="${sideLabelY}" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Longest Streak</text>

    ${createSpotifyCard(spotify.trackName, spotify.trackColor, viewCount)}
  </svg>`;
}

(async () => {
    console.log("Fetching GitHub data...");
    const gitHubUser = await fetchGitHubData();

    console.log("Fetching Spotify data...");
    const spotifyData = await fetchSpotifyData();

    console.log("Reading profile views...");
    const profileViewCount = readProfileViews();

    const topLanguages = getTopLanguages(gitHubUser.repositories.nodes);
    const streakData = calculateStreak(gitHubUser.contributionsCollection.contributionCalendar.weeks);
    const totalStars = gitHubUser.repositories.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0);

    const totalCommits = (gitHubUser.current?.totalCommitContributions ?? 0) + (gitHubUser.previous?.totalCommitContributions ?? 0) + (gitHubUser.current?.restrictedContributionsCount ?? 0) + (gitHubUser.previous?.restrictedContributionsCount ?? 0);
    const totalPullRequests = (gitHubUser.current?.totalPullRequestContributions ?? 0) + (gitHubUser.previous?.totalPullRequestContributions ?? 0);
    const totalIssues = (gitHubUser.current?.totalIssueContributions ?? 0) + (gitHubUser.previous?.totalIssueContributions ?? 0);

    const followerCount = gitHubUser.followers.totalCount;
    const currentYearCommits = gitHubUser.current?.totalCommitContributions ?? 0;
    const rankPercentile = calculateRank({
        commits: currentYearCommits,
        pullRequests: totalPullRequests,
        issues: totalIssues,
        stars: totalStars,
        followers: followerCount,
    });

    const svgOutput = generateSVG(
        gitHubUser,
        streakData,
        topLanguages,
        totalStars,
        totalCommits,
        totalPullRequests,
        totalIssues,
        rankPercentile,
        spotifyData,
        profileViewCount,
    );

    fs.writeFileSync("profile-card.svg", svgOutput);
    console.log("Profile-Card.svg saved");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

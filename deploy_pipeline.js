require('dotenv').config();
const AdmZip = require('adm-zip');

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_D1_DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ----------------------------------------------------
// 1. Cloudflare D1 REST Client & Secret Store
// ----------------------------------------------------
async function queryD1(sql, params = []) {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_D1_DATABASE_ID || !CLOUDFLARE_API_TOKEN) {
        throw new Error('Cloudflare D1 credentials missing in .env');
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sql, params })
    });
    const data = await res.json();
    if (!data.success) {
        throw new Error(`D1 Query Error: ${JSON.stringify(data.errors || data.messages)}`);
    }
    return data.result?.[0]?.results || [];
}

async function saveD1RepoEnvs(repoName, envMap) {
    if (!repoName || !envMap || typeof envMap !== 'object') return 0;
    const entries = Object.entries(envMap);
    let count = 0;
    for (const [key, val] of entries) {
        if (!key || key.trim() === '') continue;
        await queryD1(
            `INSERT INTO repo_envs (repo_name, env_key, env_value, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(repo_name, env_key) DO UPDATE SET env_value = excluded.env_value, updated_at = CURRENT_TIMESTAMP;`,
            [repoName, key.trim(), String(val)]
        );
        count++;
    }
    return count;
}

async function saveD1RepoDeployment(repoName, status = 'PENDING', userId = null) {
    if (!repoName) return;
    await queryD1(
        `INSERT INTO repo_deployments (repo_name, deployment_status, user_id, created_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(repo_name) DO UPDATE SET 
            deployment_status = excluded.deployment_status,
            user_id = COALESCE(excluded.user_id, repo_deployments.user_id);`,
        [repoName, status, userId ? String(userId) : null]
    );
}

async function getUserRepos(userId, isOwner = false) {
    const uStr = String(userId);
    let sql;
    let params;
    if (isOwner) {
        sql = 'SELECT repo_name, deployment_status, live_url, created_at, user_id FROM repo_deployments ORDER BY created_at DESC;';
        params = [];
    } else {
        sql = 'SELECT repo_name, deployment_status, live_url, created_at, user_id FROM repo_deployments WHERE user_id = ? ORDER BY created_at DESC;';
        params = [uStr];
    }
    return await queryD1(sql, params).catch(() => []);
}

async function getRepoDetails(repoName) {
    const rows = await queryD1('SELECT repo_name, deployment_status, live_url, created_at, user_id FROM repo_deployments WHERE repo_name = ? LIMIT 1;', [repoName]).catch(() => []);
    const envRows = await queryD1('SELECT env_key, env_value FROM repo_envs WHERE repo_name = ?;', [repoName]).catch(() => []);
    
    let ghData = null;
    try {
        const token = GITHUB_TOKEN;
        const owner = await getGitHubOwner(token);
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Multiverse-Deploy-Bot',
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (ghRes.ok) {
            ghData = await ghRes.json();
        }
    } catch (e) {
        console.warn('[getRepoDetails GitHub Warning]:', e.message);
    }

    return {
        repoName,
        deployment: rows[0] || null,
        envsCount: envRows.length,
        envs: envRows,
        github: ghData ? {
            fullName: ghData.full_name,
            htmlUrl: ghData.html_url,
            isPrivate: !!ghData.private,
            defaultBranch: ghData.default_branch || 'main',
            updatedAt: ghData.updated_at
        } : null
    };
}

async function toggleRepoVisibility(repoName) {
    const token = GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN missing in .env');
    const owner = await getGitHubOwner(token);

    // 1. Get current status
    const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Multiverse-Deploy-Bot',
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    if (!checkRes.ok) throw new Error(`Could not fetch repository from GitHub: ${checkRes.statusText}`);
    const current = await checkRes.json();
    const targetPrivate = !current.private;

    // 2. Patch visibility
    const patchRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Multiverse-Deploy-Bot',
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({ private: targetPrivate })
    });
    if (!patchRes.ok) {
        const errJson = await patchRes.json().catch(() => ({}));
        throw new Error(`Failed to update visibility: ${errJson.message || patchRes.statusText}`);
    }
    return { isPrivate: targetPrivate, repoUrl: current.html_url };
}

async function deleteRepoFromGitHubAndD1(repoName) {
    const token = GITHUB_TOKEN;
    let ghDeleted = false;
    let ghMessage = '';

    if (token) {
        try {
            const owner = await getGitHubOwner(token);
            const delRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Multiverse-Deploy-Bot',
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (delRes.status === 204 || delRes.status === 404) {
                ghDeleted = true;
            } else {
                const errJson = await delRes.json().catch(() => ({}));
                ghMessage = errJson.message || `HTTP ${delRes.status}`;
            }
        } catch (ghErr) {
            ghMessage = ghErr.message;
        }
    }

    // Delete from D1
    await queryD1('DELETE FROM repo_deployments WHERE repo_name = ?;', [repoName]).catch(() => {});
    await queryD1('DELETE FROM repo_envs WHERE repo_name = ?;', [repoName]).catch(() => {});

    return { success: true, ghDeleted, ghMessage };
}

async function clearRepoEnvs(repoName) {
    return await queryD1('DELETE FROM repo_envs WHERE repo_name = ?;', [repoName]);
}

// ----------------------------------------------------
// 2. Pure .env String Parser
// ----------------------------------------------------
function parseEnvContent(content) {
    const envs = {};
    if (!content) return envs;
    const lines = String(content).split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
            const key = trimmed.substring(0, eqIdx).trim();
            let val = trimmed.substring(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.substring(1, val.length - 1);
            }
            if (key) {
                envs[key] = val;
            }
        }
    }
    return envs;
}

// ----------------------------------------------------
// 3. Clean Repo Name Helper
// ----------------------------------------------------
function sanitizeRepoName(rawName) {
    let clean = String(rawName || '')
        .trim()
        .toLowerCase()
        .replace(/\.[^/.]+$/, '') // remove extension like .zip
        .replace(/-(main|master|dev|latest)$/i, '')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return clean || `app-${Date.now().toString(36)}`;
}

// ----------------------------------------------------
// 4. Archive Processing with Nuclear .env Stripping
// ----------------------------------------------------
function isEnvTemplateFile(filename) {
    const base = filename.split('/').pop().toLowerCase();
    return /^\.?env\.(example|sample|template|dist)$/i.test(base);
}

function isSensitiveEnvFile(filename) {
    const base = filename.split('/').pop().toLowerCase();
    if (isEnvTemplateFile(base)) return false;
    // Matches .env, .env.local, .env.production, .env.staging, .env.test, .env.development, my.env, etc.
    return /^\.env(\.[a-zA-Z0-9_\-]+)?$/i.test(base) || /\.env$/i.test(base) || base === 'local.env';
}

function extractAndPurgeRepoZip(zipBuffer, repoNameHint = '') {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    let repoName = sanitizeRepoName(repoNameHint);
    const extractedEnvs = {};
    const strippedEnvFiles = [];
    const rawFiles = [];

    // Find common wrapper directory (e.g. giveaway-main/)
    let commonPrefix = null;
    const nonDirEntries = entries.filter(e => !e.isDirectory && !e.entryName.includes('__MACOSX') && !e.entryName.includes('.DS_Store'));
    
    if (nonDirEntries.length > 0) {
        const firstSlash = nonDirEntries[0].entryName.indexOf('/');
        if (firstSlash !== -1) {
            const candidate = nonDirEntries[0].entryName.substring(0, firstSlash + 1);
            if (nonDirEntries.every(e => e.entryName.startsWith(candidate))) {
                commonPrefix = candidate;
                if (!repoNameHint) {
                    repoName = sanitizeRepoName(candidate.replace(/\/$/, ''));
                }
            }
        }
    }

    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        if (entryName.includes('__MACOSX') || entryName.includes('.DS_Store') || entryName.includes('Thumbs.db')) {
            continue;
        }

        let relPath = entryName;
        if (commonPrefix && relPath.startsWith(commonPrefix)) {
            relPath = relPath.substring(commonPrefix.length);
        }
        if (!relPath) continue;

        // Check if file is an environment secret file
        if (isSensitiveEnvFile(relPath)) {
            try {
                const textContent = entry.getData().toString('utf8');
                const parsed = parseEnvContent(textContent);
                Object.assign(extractedEnvs, parsed);
                strippedEnvFiles.push({ path: relPath, keysCount: Object.keys(parsed).length });
                console.log(`🛡️ [Security Purge] Extracted and removed ${relPath} (${Object.keys(parsed).length} vars)`);
            } catch (err) {
                console.warn(`[Security Warning] Failed to parse sensitive env file ${relPath}:`, err.message);
            }
            // CRITICAL: DO NOT ADD TO rawFiles! IT IS PERMANENTLY STRIPPED!
            continue;
        }

        // Safe file - retain for codebase
        rawFiles.push({
            path: relPath.replace(/^\/+/, ''),
            data: entry.getData()
        });
    }

    return {
        repoName,
        files: rawFiles,
        extractedEnvs,
        strippedEnvFiles,
        totalFiles: rawFiles.length
    };
}

// ----------------------------------------------------
// 5. GitHub API Autonomous Push Engine
// ----------------------------------------------------
async function getGitHubOwner(token) {
    const res = await fetch('https://api.github.com/user', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Multiverse-Deploy-Bot',
            'Accept': 'application/vnd.github.v3+json'
        }
    });
    if (!res.ok) {
        throw new Error(`GitHub Auth Failed: ${res.status} ${res.statusText}`);
    }
    const user = await res.json();
    return user.login;
}

async function ensureGitHubRepo(token, owner, repoName) {
    const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Multiverse-Deploy-Bot',
            'Accept': 'application/vnd.github.v3+json'
        }
    });

    if (checkRes.ok) {
        const repo = await checkRes.json();
        // If repo is private, make it public so URLs open directly without 404
        if (repo.private) {
            await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Multiverse-Deploy-Bot',
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({ private: false })
            }).catch(() => {});
        }
        return { created: false, defaultBranch: repo.default_branch || 'main' };
    }

    if (checkRes.status === 404) {
        const createRes = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Multiverse-Deploy-Bot',
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
                name: repoName,
                description: `Multiverse Deploy App - ${repoName}`,
                private: false,
                auto_init: true
            })
        });

        if (!createRes.ok) {
            const errJson = await createRes.json().catch(() => ({}));
            throw new Error(`Failed to create GitHub repo ${repoName}: ${errJson.message || createRes.statusText}`);
        }
        // Small delay for GitHub repository initialization
        await new Promise(r => setTimeout(r, 1500));
        return { created: true, defaultBranch: 'main' };
    }

    throw new Error(`GitHub Repo Check Error: ${checkRes.status}`);
}

async function pushFilesToGitHub(repoName, files, commitMessage = 'Deploy application via Multiverse [skip ci]') {
    const token = GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN is missing in .env');
    }

    const owner = await getGitHubOwner(token);
    const { defaultBranch } = await ensureGitHubRepo(token, owner, repoName);

    console.log(`🚀 [GitHub Push] Pushing ${files.length} files to ${owner}/${repoName} (${defaultBranch})...`);

    // 1. Get latest parent commit SHA if branch exists
    let parentCommitSha = null;
    let baseTreeSha = null;
    try {
        const refRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Multiverse-Deploy-Bot'
            }
        });
        if (refRes.ok) {
            const refData = await refRes.json();
            parentCommitSha = refData.object.sha;

            const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/commits/${parentCommitSha}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Multiverse-Deploy-Bot'
                }
            });
            if (commitRes.ok) {
                const commitData = await commitRes.json();
                baseTreeSha = commitData.tree.sha;
            }
        }
    } catch (refErr) {
        console.warn('[GitHub Ref Warning]:', refErr.message);
    }

    // 2. Upload blobs for all files in batches of 10
    const treeEntries = [];
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(batch.map(async (file) => {
            const base64Content = file.data.toString('base64');
            const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/blobs`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Multiverse-Deploy-Bot',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    content: base64Content,
                    encoding: 'base64'
                })
            });

            if (!blobRes.ok) {
                const bErr = await blobRes.json().catch(() => ({}));
                console.warn(`[Blob Warning] Failed for ${file.path}:`, bErr.message);
                return;
            }

            const blobData = await blobRes.json();
            treeEntries.push({
                path: file.path,
                mode: '100644',
                type: 'blob',
                sha: blobData.sha
            });
        }));
    }

    if (treeEntries.length === 0) {
        throw new Error('No files could be staged into Git tree.');
    }

    // 3. Create Tree
    const treePayload = { tree: treeEntries };
    // If not first commit, we can set base_tree to keep existing or omit to completely replace tree
    // Replacing tree completely ensures files deleted locally are deleted on remote!
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/trees`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Multiverse-Deploy-Bot',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(treePayload)
    });

    if (!treeRes.ok) {
        const tErr = await treeRes.json().catch(() => ({}));
        throw new Error(`Failed to create Git tree: ${tErr.message || treeRes.statusText}`);
    }
    const treeData = await treeRes.json();

    // 4. Create Commit
    const commitPayload = {
        message: commitMessage,
        tree: treeData.sha,
        parents: parentCommitSha ? [parentCommitSha] : []
    };
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/commits`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Multiverse-Deploy-Bot',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(commitPayload)
    });

    if (!commitRes.ok) {
        const cErr = await commitRes.json().catch(() => ({}));
        throw new Error(`Failed to create Git commit: ${cErr.message || commitRes.statusText}`);
    }
    const commitData = await commitRes.json();

    // 5. Update or Create Ref
    let refUpdated = false;
    if (parentCommitSha) {
        const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${defaultBranch}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Multiverse-Deploy-Bot',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sha: commitData.sha,
                force: true
            })
        });
        refUpdated = updateRes.ok;
    }

    if (!refUpdated) {
        const createRefRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/git/refs`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Multiverse-Deploy-Bot',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ref: `refs/heads/${defaultBranch}`,
                sha: commitData.sha
            })
        });
        if (!createRefRes.ok) {
            console.warn('[Ref Notice]: Failed to create direct ref, checking branch status.');
        }
    }

    return {
        success: true,
        owner,
        repoName,
        repoUrl: `https://github.com/${owner}/${repoName}`,
        commitSha: commitData.sha.substring(0, 7),
        fullSha: commitData.sha,
        branch: defaultBranch,
        filesCount: treeEntries.length
    };
}

// ----------------------------------------------------
// 6. Public GitHub Repo Downloader (Helper for link input)
// ----------------------------------------------------
async function downloadGitHubRepoZip(repoUrl) {
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/i);
    if (!match) throw new Error('Invalid GitHub repository URL');
    const owner = match[1];
    const repo = match[2];

    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/main`;
    const res = await fetch(zipUrl, {
        headers: {
            'User-Agent': 'Multiverse-Deploy-Bot',
            ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {})
        },
        redirect: 'follow'
    });

    if (!res.ok) {
        // try master branch fallback
        const masterUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/master`;
        const res2 = await fetch(masterUrl, {
            headers: {
                'User-Agent': 'Multiverse-Deploy-Bot',
                ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {})
            },
            redirect: 'follow'
        });
        if (!res2.ok) {
            throw new Error(`Failed to download repository ZIP from GitHub: ${res.statusText}`);
        }
        const ab = await res2.arrayBuffer();
        return { buffer: Buffer.from(ab), repoName: repo };
    }

    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), repoName: repo };
}

// ----------------------------------------------------
// 7. Robust Telegram File Downloader (Buffer Streamer)
// ----------------------------------------------------
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

async function downloadTelegramFileBuffer(bot, fileId) {
    const tempDir = path.resolve(__dirname, 'sessions', 'downloads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // Method 1: Official bot.downloadFile stream
    try {
        const downloadedPath = await bot.downloadFile(fileId, tempDir);
        if (downloadedPath && fs.existsSync(downloadedPath)) {
            const buffer = fs.readFileSync(downloadedPath);
            try { fs.unlinkSync(downloadedPath); } catch (e) {}
            if (buffer && buffer.length > 0) {
                return buffer;
            }
        }
    } catch (dErr) {
        console.warn('[downloadTelegramFileBuffer] Primary downloadFile notice:', dErr.message);
    }

    // Method 2: Node native https.get following redirects (handles CDN 302s)
    const fileLink = await bot.getFileLink(fileId);
    return new Promise((resolve, reject) => {
        function fetchStream(url, depth = 0) {
            if (depth > 5) return reject(new Error('Too many redirects while downloading Telegram file'));
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let nextUrl = res.headers.location;
                    if (!nextUrl.startsWith('http')) {
                        const parsed = new URL(url);
                        nextUrl = `${parsed.protocol}//${parsed.host}${nextUrl}`;
                    }
                    return fetchStream(nextUrl, depth + 1);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Telegram file server returned HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', (err) => {
                // Method 3: Fallback to global fetch as absolute last resort
                fetch(url)
                    .then(r => {
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        return r.arrayBuffer();
                    })
                    .then(ab => resolve(Buffer.from(ab)))
                    .catch(reject);
            });
        }
        fetchStream(fileLink);
    });
}

module.exports = {
    queryD1,
    saveD1RepoEnvs,
    saveD1RepoDeployment,
    parseEnvContent,
    sanitizeRepoName,
    isEnvTemplateFile,
    isSensitiveEnvFile,
    extractAndPurgeRepoZip,
    pushFilesToGitHub,
    downloadGitHubRepoZip,
    downloadTelegramFileBuffer,
    getUserRepos,
    getRepoDetails,
    toggleRepoVisibility,
    deleteRepoFromGitHubAndD1,
    clearRepoEnvs
};

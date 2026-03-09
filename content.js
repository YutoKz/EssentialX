let isFetching = false;
let currentTopicKeyword = "";

// TODO: ここにGemini APIキーを設定してください
const GEMINI_API_KEY = "AIzaSyAe2yrc9Nf-iAq-1j_Bi8HPWZVA5cpv5Fo";

// TODO: 必要であれば追加の指示文を設定してください（任意）
const GEMINI_EXTRA_PROMPT = "ゲームアプリ等の明らかな広告は除外してください。" //"表示する各ツイートはアカウントごとにまとめ、形式は「[@アカウント名] \n- ツイート内容\n- ツイート内容\n\n」としてください。";

function buildGeminiPrompt(topicKeyword) {
    const normalizedKeyword = String(topicKeyword || "").trim();
    if (!normalizedKeyword) {
        return "以下のトピックに関連するものだけを抽出してください。";
    }
    return `以下のトピックに関連するものだけを抽出してください。\nトピック: ${normalizedKeyword}`;
}

function normalizeTwitterImageUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (url.hostname.includes("pbs.twimg.com") && url.searchParams.has("name")) {
            url.searchParams.set("name", "large");
        }
        return url.toString();
    } catch {
        return rawUrl;
    }
}

function extractTweetImageUrls(article) {
    const imageUrls = new Set();
    const imageElements = article.querySelectorAll("img[src]");

    imageElements.forEach((img) => {
        const src = img.getAttribute("src");
        if (!src) {
            return;
        }

        let pathname = "";
        try {
            pathname = new URL(src).pathname;
        } catch {
            pathname = "";
        }

        const isTweetMedia =
            pathname.startsWith("/media/") ||
            pathname.startsWith("/ext_tw_video_thumb/") ||
            pathname.startsWith("/tweet_video_thumb/");

        if (!isTweetMedia) {
            return;
        }

        imageUrls.add(normalizeTwitterImageUrl(src));
    });

    return Array.from(imageUrls);
}

function normalizeForGeminiMatch(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function parseGeminiSelectedIndices(geminiResultText, maxCount) {
    const text = String(geminiResultText || "");
    const pushUnique = (arr, n) => {
        if (n >= 1 && n <= maxCount && !arr.includes(n)) {
            arr.push(n);
        }
    };

    const fromLabeledSection = [];
    const labeledMatch = text.match(/抽出(?:ID|id|番号)?\s*[:：]\s*([0-9,\s]+)/);
    if (labeledMatch && labeledMatch[1]) {
        const tokens = labeledMatch[1].split(/[\s,、]+/);
        tokens.forEach((token) => {
            const n = Number(token);
            if (Number.isInteger(n)) {
                pushUnique(fromLabeledSection, n);
            }
        });
    }
    if (fromLabeledSection.length > 0) {
        return fromLabeledSection;
    }

    const fromBrackets = [];
    const bracketMatches = text.matchAll(/\[(\d{1,4})\]/g);
    for (const match of bracketMatches) {
        const n = Number(match[1]);
        if (Number.isInteger(n)) {
            pushUnique(fromBrackets, n);
        }
    }
    if (fromBrackets.length > 0) {
        return fromBrackets;
    }

    const fallback = [];
    const numberMatches = text.match(/\b\d{1,4}\b/g) || [];
    numberMatches.forEach((token) => {
        const n = Number(token);
        if (Number.isInteger(n)) {
            pushUnique(fallback, n);
        }
    });

    return fallback;
}

function formatTweetForCopy(tweet, index) {
    const account = String(tweet?.account || "unknown");
    const text = String(tweet?.text || "");
    const images = Array.isArray(tweet?.images) ? tweet.images : [];
    const imageLines = images.length > 0
        ? `\n画像URL:\n${images.join("\n")}`
        : "\n画像URL: なし";
    return `${index}. [@${account}] ${text}${imageLines}`;
}

function createTweetCardElement(tweet, displayIndex) {
    const account = String(tweet?.account || "unknown");
    const text = String(tweet?.text || "");
    const images = Array.isArray(tweet?.images) ? tweet.images : [];

    const item = document.createElement("div");
    Object.assign(item.style, {
        padding: "8px",
        marginBottom: "8px",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        lineHeight: "1.5",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
    });

    const topLine = document.createElement("div");
    Object.assign(topLine.style, {
        marginBottom: "8px"
    });

    const numberSpan = document.createElement("span");
    numberSpan.textContent = `${displayIndex}. `;
    Object.assign(numberSpan.style, {
        color: "#666",
        marginRight: "4px"
    });

    const accountSpan = document.createElement("span");
    accountSpan.textContent = `@${account}`;
    Object.assign(accountSpan.style, {
        fontWeight: "bold",
        color: "#1d9bf0",
        marginRight: "8px"
    });

    const textSpan = document.createElement("span");
    textSpan.textContent = text;

    topLine.append(numberSpan, accountSpan, textSpan);
    item.appendChild(topLine);

    if (images.length > 0) {
        const imageLabel = document.createElement("div");
        imageLabel.textContent = `添付画像: ${images.length}件`;
        Object.assign(imageLabel.style, {
            fontSize: "12px",
            color: "#666",
            marginBottom: "6px"
        });
        item.appendChild(imageLabel);

        const imageGrid = document.createElement("div");
        Object.assign(imageGrid.style, {
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
            gap: "8px"
        });

        images.forEach((imageUrl, imageIndex) => {
            const imageLink = document.createElement("a");
            imageLink.href = imageUrl;
            imageLink.target = "_blank";
            imageLink.rel = "noopener noreferrer";

            const image = document.createElement("img");
            image.src = imageUrl;
            image.alt = `tweet image ${imageIndex + 1}`;
            image.loading = "lazy";
            Object.assign(image.style, {
                width: "100%",
                height: "120px",
                objectFit: "cover",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                background: "#f3f4f6"
            });

            imageLink.appendChild(image);
            imageGrid.appendChild(imageLink);
        });

        item.appendChild(imageGrid);
    }

    return item;
}

function selectTweetsForGeminiResult(tweets, geminiResultText) {
    const selectedIndices = parseGeminiSelectedIndices(geminiResultText, tweets.length);
    if (selectedIndices.length > 0) {
        return selectedIndices
            .map((index) => tweets[index - 1])
            .filter((tweet) => Boolean(tweet));
    }

    const normalizedResult = normalizeForGeminiMatch(geminiResultText);
    if (!normalizedResult) {
        return [];
    }

    return tweets.filter((tweet) => {
        const accountToken = tweet.account ? `@${String(tweet.account).toLowerCase()}` : "";
        if (accountToken && normalizedResult.includes(accountToken)) {
            return true;
        }

        const normalizedTweetText = normalizeForGeminiMatch(tweet.text);
        if (!normalizedTweetText) {
            return false;
        }

        const snippet = normalizedTweetText.slice(0, 28);
        return snippet.length >= 12 && normalizedResult.includes(snippet);
    });
}

function showGeminiResultWindow(result, topicKeyword, relatedTweets = []) {
    const existingWindow = document.getElementById("gemini-result-window");
    if (existingWindow) {
        existingWindow.remove();
    }

    const panel = document.createElement("div");
    panel.id = "gemini-result-window";
    Object.assign(panel.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "700px",
        maxWidth: "90vw",
        height: "80vh",
        zIndex: "2147483648",
        background: "#ffffff",
        color: "#111111",
        border: "1px solid #d9d9d9",
        borderRadius: "10px",
        boxShadow: "0 12px 28px rgba(0, 0, 0, 0.3)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "Segoe UI, Arial, sans-serif"
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
        padding: "12px 14px",
        background: "#4285f4",
        color: "#ffffff",
        borderBottom: "1px solid #3367d6",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "move",
        userSelect: "none"
    });

    const title = document.createElement("strong");
    title.textContent = topicKeyword 
        ? `Gemini応答 - ${topicKeyword}` 
        : "Gemini応答";
    Object.assign(title.style, {
        fontSize: "14px"
    });

    const actionArea = document.createElement("div");
    Object.assign(actionArea.style, {
        display: "flex",
        gap: "8px"
    });

    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy";
    Object.assign(copyButton.style, {
        border: "1px solid #ffffff",
        background: "transparent",
        color: "#ffffff",
        borderRadius: "6px",
        padding: "4px 10px",
        cursor: "pointer",
        fontSize: "12px"
    });
    copyButton.addEventListener("click", async () => {
        const copyPayload = relatedTweets.length > 0
            ? relatedTweets.map((tweet, index) => formatTweetForCopy(tweet, index + 1)).join("\n---\n")
            : result;

        try {
            await navigator.clipboard.writeText(copyPayload);
            copyButton.textContent = "Copied!";
            setTimeout(() => {
                copyButton.textContent = "Copy";
            }, 1500);
        } catch {
            copyButton.textContent = "Failed";
            setTimeout(() => {
                copyButton.textContent = "Copy";
            }, 1500);
        }
    });

    const closeButton = document.createElement("button");
    closeButton.textContent = "×";
    Object.assign(closeButton.style, {
        border: "1px solid #ffffff",
        background: "transparent",
        color: "#ffffff",
        borderRadius: "6px",
        padding: "4px 10px",
        cursor: "pointer",
        fontSize: "16px",
        lineHeight: "1"
    });
    closeButton.addEventListener("click", () => {
        panel.remove();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    });

    actionArea.append(copyButton, closeButton);
    header.append(title, actionArea);

    const body = document.createElement("div");
    Object.assign(body.style, {
        overflow: "auto",
        padding: "14px",
        background: "#ffffff",
        flex: "1",
        fontSize: "14px"
    });

    if (relatedTweets.length > 0) {
        const heading = document.createElement("div");
        heading.textContent = `抽出結果: ${relatedTweets.length}件`;
        Object.assign(heading.style, {
            fontWeight: "bold",
            marginBottom: "10px"
        });
        body.appendChild(heading);

        relatedTweets.forEach((tweet, index) => {
            body.appendChild(createTweetCardElement(tweet, index + 1));
        });

        const rawDetails = document.createElement("details");
        Object.assign(rawDetails.style, {
            marginTop: "8px",
            borderTop: "1px solid #e5e7eb",
            paddingTop: "8px"
        });

        const rawSummary = document.createElement("summary");
        rawSummary.textContent = "Geminiの生レスポンスを表示";
        Object.assign(rawSummary.style, {
            cursor: "pointer",
            color: "#475569"
        });

        const rawText = document.createElement("div");
        Object.assign(rawText.style, {
            marginTop: "8px",
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "#334155"
        });
        rawText.textContent = result;

        rawDetails.append(rawSummary, rawText);
        body.appendChild(rawDetails);
    } else {
        const resultText = document.createElement("div");
        Object.assign(resultText.style, {
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word"
        });
        resultText.textContent = result;
        body.appendChild(resultText);
    }

    panel.append(header, body);
    document.body.appendChild(panel);

    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseMove = (event) => {
        if (!isDragging) {
            return;
        }
        panel.style.transform = "none";
        panel.style.left = `${event.clientX - offsetX}px`;
        panel.style.top = `${event.clientY - offsetY}px`;
    };

    const onMouseUp = () => {
        isDragging = false;
    };

    header.addEventListener("mousedown", (event) => {
        const rect = panel.getBoundingClientRect();
        isDragging = true;
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
    });
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

async function sendToGemini(tweets, topicKeyword) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
        alert("Gemini APIキーが設定されていません。content.jsのGEMINI_API_KEYを設定してください。");
        return;
    }

    const normalizedKeyword = String(topicKeyword || "").trim();
    if (!normalizedKeyword) {
        alert("キーワードが設定されていません。拡張機能ポップアップでキーワードを設定してから実行してください。");
        return;
    }

    const tweetText = tweets.map((tweet, index) => formatTweetForCopy(tweet, index + 1)).join("\n\n");

    const basePrompt = buildGeminiPrompt(normalizedKeyword);
    const fixedFormatPrompt = "出力ルール: 抽出対象の番号を必ず1始まりで示し、先頭行を「抽出ID: 1,2,5」の形式で返してください。";
    const promptText = GEMINI_EXTRA_PROMPT
        ? `${basePrompt}\n${fixedFormatPrompt}\n${GEMINI_EXTRA_PROMPT}`
        : `${basePrompt}\n${fixedFormatPrompt}`;

    const requestBody = {
        contents: [{
            parts: [{
                text: `${promptText}\n\n${tweetText}`
            }]
        }]
    };

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody)
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "応答を取得できませんでした。";
        const relatedTweets = selectTweetsForGeminiResult(tweets, result);
        
        console.log("Gemini Response:", result);
        showGeminiResultWindow(result, topicKeyword, relatedTweets);
        return result;
    } catch (error) {
        console.error("Gemini API Error:", error);
        const fallbackTweets = tweets.filter(
            (tweet) => Array.isArray(tweet.images) && tweet.images.length > 0
        );
        showGeminiResultWindow(`エラーが発生しました:\n\n${error.message}`, topicKeyword, fallbackTweets);
        throw error;
    }
}

function showTweetWindow(tweets, targetCount, topicKeyword) {
    const existingWindow = document.getElementById("tweet-fetcher-window");
    if (existingWindow) {
        existingWindow.remove();
    }

    const panel = document.createElement("div");
    panel.id = "tweet-fetcher-window";
    Object.assign(panel.style, {
        position: "fixed",
        top: "24px",
        right: "24px",
        width: "640px",
        maxWidth: "95vw",
        height: "70vh",
        zIndex: "2147483647",
        background: "#ffffff",
        color: "#111111",
        border: "1px solid #d9d9d9",
        borderRadius: "10px",
        boxShadow: "0 12px 28px rgba(0, 0, 0, 0.2)",
        display: "flex",
        flexDirection: "column",
        resize: "both",
        overflow: "hidden",
        fontFamily: "Segoe UI, Arial, sans-serif"
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
        padding: "10px 12px",
        background: "#f3f4f6",
        borderBottom: "1px solid #e5e7eb",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "move",
        userSelect: "none"
    });

    const title = document.createElement("strong");
    const keywordSuffix = topicKeyword ? ` | keyword: ${topicKeyword}` : "";
    title.textContent = `Tweet Collector (${tweets.length}/${targetCount})${keywordSuffix}`;

    const actionArea = document.createElement("div");
    Object.assign(actionArea.style, {
        display: "flex",
        gap: "8px"
    });

    const geminiButton = document.createElement("button");
    geminiButton.textContent = "Send to Gemini";
    Object.assign(geminiButton.style, {
        border: "1px solid #d1d5db",
        background: "#4285f4",
        color: "#ffffff",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: "12px"
    });
    geminiButton.addEventListener("click", async () => {
        geminiButton.disabled = true;
        geminiButton.textContent = "Sending...";
        try {
            await sendToGemini(tweets, topicKeyword || currentTopicKeyword);
            geminiButton.textContent = "Sent!";
            setTimeout(() => {
                geminiButton.textContent = "Send to Gemini";
                geminiButton.disabled = false;
            }, 2000);
        } catch {
            geminiButton.textContent = "Failed";
            setTimeout(() => {
                geminiButton.textContent = "Send to Gemini";
                geminiButton.disabled = false;
            }, 2000);
        }
    });

    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy";
    Object.assign(copyButton.style, {
        border: "1px solid #d1d5db",
        background: "#ffffff",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer"
    });
    copyButton.addEventListener("click", async () => {
        const allText = tweets.map((tweet, index) => formatTweetForCopy(tweet, index + 1)).join("\n---\n");
        try {
            await navigator.clipboard.writeText(allText);
            copyButton.textContent = "Copied";
            setTimeout(() => {
                copyButton.textContent = "Copy";
            }, 1000);
        } catch {
            copyButton.textContent = "Copy failed";
            setTimeout(() => {
                copyButton.textContent = "Copy";
            }, 1200);
        }
    });

    const closeButton = document.createElement("button");
    closeButton.textContent = "x";
    Object.assign(closeButton.style, {
        border: "1px solid #d1d5db",
        background: "#ffffff",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer"
    });
    closeButton.addEventListener("click", () => {
        panel.remove();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    });

    actionArea.append(geminiButton, copyButton, closeButton);
    header.append(title, actionArea);

    const body = document.createElement("div");
    Object.assign(body.style, {
        overflow: "auto",
        padding: "10px",
        background: "#ffffff",
        flex: "1"
    });

    if (tweets.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "ツイートを取得できませんでした。";
        body.appendChild(empty);
    } else {
        tweets.forEach((tweet, index) => {
            body.appendChild(createTweetCardElement(tweet, index + 1));
        });
    }

    panel.append(header, body);
    document.body.appendChild(panel);

    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseMove = (event) => {
        if (!isDragging) {
            return;
        }
        panel.style.right = "auto";
        panel.style.left = `${event.clientX - offsetX}px`;
        panel.style.top = `${event.clientY - offsetY}px`;
    };

    const onMouseUp = () => {
        isDragging = false;
    };

    header.addEventListener("mousedown", (event) => {
        const rect = panel.getBoundingClientRect();
        isDragging = true;
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
    });
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

async function fetchTweets(targetCount = 100, topicKeyword = "") {
    if (isFetching) {
        console.warn("すでにツイート取得処理が実行中です。");
        return [];
    }

    isFetching = true;
    currentTopicKeyword = String(topicKeyword || "").trim();
    const tweetsMap = new Map(); // key: status link or account+text, value: {account, text, images}
    let previousSize = 0;
    let noProgressRounds = 0;
    const maxNoProgressRounds = 8;

    try {
        while (tweetsMap.size < targetCount) {
            const articles = document.querySelectorAll('article');

            articles.forEach((article) => {
                if (tweetsMap.size >= targetCount) {
                    return;
                }

                // ツイート本文を取得
                const tweetTextElement = article.querySelector('div[data-testid="tweetText"]');
                if (!tweetTextElement) {
                    return;
                }

                const tweetText = tweetTextElement.innerText.replace(/\n/g, " ");
                const imageUrls = extractTweetImageUrls(article);

                // アカウント名を取得（複数の方法を試行）
                let accountName = "unknown";
                
                // 方法1: data-testid="User-Name"内のリンク
                const userNameElement = article.querySelector('[data-testid="User-Name"] a[role="link"]');
                if (userNameElement) {
                    const href = userNameElement.getAttribute("href");
                    if (href && href.startsWith("/")) {
                        accountName = href.substring(1).split("/")[0];
                    }
                }

                // 方法2: time要素の親リンク
                if (accountName === "unknown") {
                    const timeElement = article.querySelector('time');
                    if (timeElement) {
                        const linkElement = timeElement.closest('a');
                        if (linkElement) {
                            const href = linkElement.getAttribute("href");
                            if (href) {
                                const match = href.match(/^\/([^\/]+)\//);
                                if (match) {
                                    accountName = match[1];
                                }
                            }
                        }
                    }
                }

                // 方法3: statusリンクからアカウント名
                if (accountName === "unknown") {
                    const statusLinkElement = article.querySelector('a[href*="/status/"]');
                    const statusHref = statusLinkElement?.getAttribute("href") || "";
                    const statusMatch = statusHref.match(/^\/([^\/]+)\/status\//);
                    if (statusMatch) {
                        accountName = statusMatch[1];
                    }
                }

                const statusLinkElement = article.querySelector('a[href*="/status/"]');
                const statusHref = statusLinkElement?.getAttribute("href") || "";
                const dedupeKey = statusHref || `${accountName}::${tweetText}`;

                if (!tweetsMap.has(dedupeKey)) {
                    tweetsMap.set(dedupeKey, {
                        account: accountName,
                        text: tweetText,
                        images: imageUrls
                    });
                } else if (imageUrls.length > 0) {
                    const existingTweet = tweetsMap.get(dedupeKey);
                    const existingImages = Array.isArray(existingTweet.images) ? existingTweet.images : [];
                    const mergedImages = Array.from(new Set([...existingImages, ...imageUrls]));
                    if (mergedImages.length !== existingImages.length) {
                        tweetsMap.set(dedupeKey, {
                            ...existingTweet,
                            images: mergedImages
                        });
                    }
                }
            });

            console.log(`現在 ${tweetsMap.size} 個のツイートを取得済み...`);

            if (tweetsMap.size >= targetCount) {
                break;
            }

            if (tweetsMap.size === previousSize) {
                noProgressRounds += 1;
            } else {
                previousSize = tweetsMap.size;
                noProgressRounds = 0;
            }

            if (noProgressRounds >= maxNoProgressRounds) {
                console.warn("これ以上新しいツイートを取得できないため、途中結果を表示します。");
                break;
            }

            window.scrollBy(0, 1000);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        const result = Array.from(tweetsMap.values()).slice(0, targetCount);
        console.log(`取得完了: ${result.length} 件`);
        showTweetWindow(result, targetCount, currentTopicKeyword);
        return result;
    } finally {
        isFetching = false;
    }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== "START_FETCH") {
            return false;
        }

        const requestedCount = Number(message.targetCount);
        const targetCount = Number.isFinite(requestedCount) && requestedCount > 0
            ? Math.floor(requestedCount)
            : 100;
        const topicKeyword = typeof message.keyword === "string" ? message.keyword.trim() : "";

        fetchTweets(targetCount, topicKeyword).catch((error) => {
            console.error("ツイート取得中にエラーが発生しました", error);
        });

        sendResponse({ ok: true });
        return false;
    });
}
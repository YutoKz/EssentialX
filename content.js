let isFetching = false;
let currentTopicKeyword = "";

// TODO: 必要であれば追加の指示文を設定してください（任意）
const GEMINI_EXTRA_PROMPT = "ゲームアプリ等の明らかな広告は除外してください。" //"表示する各ツイートはアカウントごとにまとめ、形式は「[@アカウント名] \n- ツイート内容\n- ツイート内容\n\n」としてください。";

async function getGeminiApiKey() {
    try {
        const result = await chrome.storage.local.get("savedGeminiApiKey");
        return result.savedGeminiApiKey || "";
    } catch (error) {
        console.error("APIキーの取得に失敗しました:", error);
        return "";
    }
}

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

function extractJsonObjectFromGeminiResult(resultText) {
    const text = String(resultText || "");
    
    // ```json ... ``` ブロックを検索
    const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fencedMatch && fencedMatch[1]) {
        try {
            return JSON.parse(fencedMatch[1].trim());
        } catch {
            // パース失敗時は次の方法へ
        }
    }
    
    // JSON オブジェクト全体を直接検索
    const directMatch = text.match(/\{[\s\S]*\}/);
    if (directMatch) {
        try {
            return JSON.parse(directMatch[0]);
        } catch {
            // パース失敗
        }
    }
    
    return null;
}

function parseGeminiGroupedResult(resultText, tweets) {
    const jsonObj = extractJsonObjectFromGeminiResult(resultText);
    if (!jsonObj || !Array.isArray(jsonObj.groups)) {
        return null;
    }
    
    const summary = String(jsonObj.summary || "");
    const groups = [];
    
    for (const g of jsonObj.groups) {
        const keyword = String(g.keyword || "").trim();
        const reason = String(g.reason || "").trim();
        const ids = Array.isArray(g.ids) ? g.ids : [];
        
        if (!keyword || ids.length === 0) {
            continue;
        }
        
        const relatedTweets = ids
            .filter((id) => Number.isInteger(id) && id >= 1 && id <= tweets.length)
            .map((id) => tweets[id - 1])
            .filter((tweet) => Boolean(tweet));
        
        if (relatedTweets.length > 0) {
            groups.push({ keyword, reason, tweets: relatedTweets });
        }
    }
    
    return groups.length > 0 ? { summary, groups } : null;
}

function buildFallbackGroupedResult(tweets, geminiResultText, topicKeyword) {
    const relatedTweets = selectTweetsForGeminiResult(tweets, geminiResultText);
    
    if (relatedTweets.length === 0) {
        return null;
    }
    
    return {
        summary: `キーワード「${topicKeyword}」に関連するツイートを抽出しました。`,
        groups: [
            {
                keyword: topicKeyword,
                reason: "Gemini応答との一致で抽出",
                tweets: relatedTweets
            }
        ]
    };
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

function showGeminiResultWindow(result, topicKeyword, groupedResult = null) {
    const existingWindow = document.getElementById("gemini-result-window");
    if (existingWindow) {
        existingWindow.remove();
    }

    const panel = document.createElement("div");
    panel.id = "gemini-result-window";
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
    title.textContent = `Gemini Result${keywordSuffix}`;

    const actionArea = document.createElement("div");
    Object.assign(actionArea.style, {
        display: "flex",
        gap: "8px"
    });

    // グループ化されたツイートを全て集める（コピー用）
    const allRelatedTweets = groupedResult?.groups
        ? groupedResult.groups.flatMap((g) => g.tweets)
        : [];

    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy";
    Object.assign(copyButton.style, {
        border: "1px solid #d1d5db",
        background: "#ffffff",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: "12px"
    });
    copyButton.addEventListener("click", async () => {
        let copyPayload = result;
        
        if (groupedResult && groupedResult.groups && groupedResult.groups.length > 0) {
            const groupTexts = groupedResult.groups.map((group, gIndex) => {
                const groupHeader = `\n■ グループ ${gIndex + 1}: ${group.keyword}\n理由: ${group.reason}\n`;
                const tweetTexts = group.tweets
                    .map((tweet, tIndex) => formatTweetForCopy(tweet, tIndex + 1))
                    .join("\n---\n");
                return groupHeader + tweetTexts;
            });
            copyPayload = `${groupedResult.summary}\n${groupTexts.join("\n\n")}`;
        } else if (allRelatedTweets.length > 0) {
            copyPayload = allRelatedTweets
                .map((tweet, index) => formatTweetForCopy(tweet, index + 1))
                .join("\n---\n");
        }

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
    closeButton.textContent = "x";
    Object.assign(closeButton.style, {
        border: "1px solid #d1d5db",
        background: "#ffffff",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: "14px"
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
        padding: "10px",
        background: "#ffffff",
        flex: "1",
        fontSize: "14px"
    });

    // グループ化された結果を表示
    if (groupedResult && groupedResult.groups && groupedResult.groups.length > 0) {
        const heading = document.createElement("div");
        heading.textContent = `キーワード別抽出: ${groupedResult.groups.length}グループ`;
        Object.assign(heading.style, {
            fontWeight: "bold",
            marginBottom: "10px",
            fontSize: "16px"
        });
        body.appendChild(heading);

        // サマリーを表示
        if (groupedResult.summary) {
            const summaryBox = document.createElement("div");
            summaryBox.textContent = groupedResult.summary;
            Object.assign(summaryBox.style, {
                padding: "10px",
                marginBottom: "12px",
                background: "#f0f9ff",
                border: "1px solid #bfdbfe",
                borderRadius: "6px",
                lineHeight: "1.5"
            });
            body.appendChild(summaryBox);
        }

        // 各グループを表示
        groupedResult.groups.forEach((group, gIndex) => {
            const groupContainer = document.createElement("div");
            Object.assign(groupContainer.style, {
                marginBottom: "16px"
            });

            const groupTitle = document.createElement("div");
            groupTitle.textContent = `${gIndex + 1}. ${group.keyword} (${group.tweets.length}件)`;
            Object.assign(groupTitle.style, {
                fontWeight: "bold",
                marginBottom: "6px",
                fontSize: "15px",
                color: "#1e40af"
            });
            groupContainer.appendChild(groupTitle);

            if (group.reason) {
                const reasonText = document.createElement("div");
                reasonText.textContent = `理由: ${group.reason}`;
                Object.assign(reasonText.style, {
                    fontSize: "13px",
                    color: "#64748b",
                    marginBottom: "8px",
                    marginLeft: "8px"
                });
                groupContainer.appendChild(reasonText);
            }

            const tweetsContainer = document.createElement("div");
            Object.assign(tweetsContainer.style, {
                marginLeft: "12px"
            });

            group.tweets.forEach((tweet, tIndex) => {
                tweetsContainer.appendChild(createTweetCardElement(tweet, tIndex + 1));
            });

            groupContainer.appendChild(tweetsContainer);
            body.appendChild(groupContainer);
        });

        // Geminiの生レスポンスを折りたたみで表示
        const rawDetails = document.createElement("details");
        Object.assign(rawDetails.style, {
            marginTop: "12px",
            borderTop: "1px solid #e5e7eb",
            paddingTop: "8px"
        });

        const rawSummary = document.createElement("summary");
        rawSummary.textContent = "Geminiの生レスポンスを表示";
        Object.assign(rawSummary.style, {
            cursor: "pointer",
            color: "#475569",
            fontSize: "13px"
        });

        const rawText = document.createElement("div");
        Object.assign(rawText.style, {
            marginTop: "8px",
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "#334155",
            fontSize: "13px"
        });
        rawText.textContent = result;

        rawDetails.append(rawSummary, rawText);
        body.appendChild(rawDetails);
    } else if (allRelatedTweets.length > 0) {
        // グループ化されていないが関連ツイートがある場合（後方互換性）
        const heading = document.createElement("div");
        heading.textContent = `抽出結果: ${allRelatedTweets.length}件`;
        Object.assign(heading.style, {
            fontWeight: "bold",
            marginBottom: "10px"
        });
        body.appendChild(heading);

        allRelatedTweets.forEach((tweet, index) => {
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
        // テキストのみを表示
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

async function sendToGemini(tweets, topicKeyword) {
    const GEMINI_API_KEY = await getGeminiApiKey();
    
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
        alert("Gemini APIキーが設定されていません。拡張機能のポップアップでAPIキーを設定してください。");
        return;
    }

    const normalizedKeyword = String(topicKeyword || "").trim();
    if (!normalizedKeyword) {
        alert("キーワードが設定されていません。拡張機能ポップアップでキーワードを設定してから実行してください。");
        return;
    }

    const tweetText = tweets.map((tweet, index) => formatTweetForCopy(tweet, index + 1)).join("\n\n");

    const basePrompt = buildGeminiPrompt(normalizedKeyword);
    
    // JSON形式でグループ化された結果を要求
    const jsonFormatPrompt = `
以下のルールに従って、指定されたトピックに関連するツイートを抽出し、キーワードごとにグループ化してください。

ルール:
1) 必ずJSONのみを返す（前後に説明文やコードブロックを付けない）
2) 形式: {"summary": "全体の要約", "groups": [{"keyword": "キーワード", "ids": [ツイート番号の配列], "reason": "抽出理由"}]}
3) groupsは関連度が高い順に並べる
4) idsは重複なし、1から始まる整数の配列
5) 各グループのkeywordは具体的で分かりやすい名前を付ける

${GEMINI_EXTRA_PROMPT ? `追加指示: ${GEMINI_EXTRA_PROMPT}\n` : ""}
トピック: ${normalizedKeyword}
`.trim();

    const requestBody = {
        contents: [{
            parts: [{
                text: `${jsonFormatPrompt}\n\n${tweetText}`
            }]
        }]
    };

    try {
        const response = await fetch(
            //`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
        
        console.log("Gemini Response:", result);
        
        // グループ化された結果をパース（失敗時はフォールバック）
        const groupedResult = 
            parseGeminiGroupedResult(result, tweets) ||
            buildFallbackGroupedResult(tweets, result, normalizedKeyword);
        
        showGeminiResultWindow(result, topicKeyword, groupedResult);
        return result;
    } catch (error) {
        console.error("Gemini API Error:", error);
        const fallbackTweets = tweets.filter(
            (tweet) => Array.isArray(tweet.images) && tweet.images.length > 0
        );
        const fallbackGrouped = fallbackTweets.length > 0
            ? { summary: "エラーが発生しました", groups: [{ keyword: "画像付きツイート", reason: "フォールバック", tweets: fallbackTweets }] }
            : null;
        showGeminiResultWindow(`エラーが発生しました:\n\n${error.message}`, topicKeyword, fallbackGrouped);
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
    geminiButton.textContent = "Auto Sending...";
    Object.assign(geminiButton.style, {
        border: "1px solid #d1d5db",
        background: "#4285f4",
        color: "#ffffff",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer",
        fontSize: "12px"
    });
    const triggerGeminiSend = async (isAuto = false) => {
        geminiButton.disabled = true;
        geminiButton.textContent = isAuto ? "Auto Sending..." : "Sending...";
        try {
            await sendToGemini(tweets, topicKeyword || currentTopicKeyword);
            geminiButton.textContent = isAuto ? "Sent (Auto)" : "Sent!";
            setTimeout(() => {
                geminiButton.textContent = "Resend to Gemini";
                geminiButton.disabled = false;
            }, 2000);
        } catch {
            geminiButton.textContent = "Failed";
            setTimeout(() => {
                geminiButton.textContent = "Retry Gemini";
                geminiButton.disabled = false;
            }, 2000);
        }
    };

    geminiButton.addEventListener("click", () => {
        void triggerGeminiSend(false);
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

    // ツイート表示後に自動でGemini送信を開始
    void triggerGeminiSend(true);
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
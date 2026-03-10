const targetCountInput = document.getElementById("targetCount");
const topicKeywordInput = document.getElementById("topicKeyword");
const geminiApiKeyInput = document.getElementById("geminiApiKey");
const mailgunApiKeyInput = document.getElementById("mailgunApiKey");
const mailgunDomainInput = document.getElementById("mailgunDomain");
const emailToInput = document.getElementById("emailTo");
const startButton = document.getElementById("startButton");
const statusBox = document.getElementById("status");
const STORAGE_KEYS = {
  topicKeyword: "savedTopicKeyword",
  targetCount: "savedTargetCount",
  geminiApiKey: "savedGeminiApiKey",
  mailgunApiKey: "savedMailgunApiKey",
  mailgunDomain: "savedMailgunDomain",
  emailTo: "savedEmailTo"
};

function setStatus(text) {
  statusBox.textContent = text;
}

function isSupportedUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname === "x.com" || parsed.hostname === "twitter.com" || parsed.hostname.endsWith(".x.com") || parsed.hostname.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

async function loadSavedSettings() {
  const defaults = {
    [STORAGE_KEYS.topicKeyword]: "",
    [STORAGE_KEYS.targetCount]: 100,
    [STORAGE_KEYS.geminiApiKey]: "",
    [STORAGE_KEYS.mailgunApiKey]: "",
    [STORAGE_KEYS.mailgunDomain]: "",
    [STORAGE_KEYS.emailTo]: ""
  };

  try {
    const saved = await chrome.storage.local.get(defaults);
    targetCountInput.value = String(saved[STORAGE_KEYS.targetCount] || 100);
    topicKeywordInput.value = saved[STORAGE_KEYS.topicKeyword] || "";
    geminiApiKeyInput.value = saved[STORAGE_KEYS.geminiApiKey] || "";
    mailgunApiKeyInput.value = saved[STORAGE_KEYS.mailgunApiKey] || "";
    mailgunDomainInput.value = saved[STORAGE_KEYS.mailgunDomain] || "";
    emailToInput.value = saved[STORAGE_KEYS.emailTo] || "";
  } catch (error) {
    console.warn("設定の読み込みに失敗しました", error);
  }
}

startButton.addEventListener("click", async () => {
  const requested = Number(targetCountInput.value);
  const targetCount = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 100;
  const topicKeyword = topicKeywordInput.value.trim();
  const geminiApiKey = geminiApiKeyInput.value.trim();
  const mailgunApiKey = mailgunApiKeyInput.value.trim();
  const mailgunDomain = mailgunDomainInput.value.trim();
  const emailTo = emailToInput.value.trim();

  startButton.disabled = true;
  setStatus("開始しています...");

  try {
    if (!topicKeyword) {
      setStatus("抽出キーワードを入力してください。");
      return;
    }

    if (!geminiApiKey) {
      setStatus("Gemini APIキーを入力してください。");
      return;
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.topicKeyword]: topicKeyword,
      [STORAGE_KEYS.targetCount]: targetCount,
      [STORAGE_KEYS.geminiApiKey]: geminiApiKey,
      [STORAGE_KEYS.mailgunApiKey]: mailgunApiKey,
      [STORAGE_KEYS.mailgunDomain]: mailgunDomain,
      [STORAGE_KEYS.emailTo]: emailTo
    });

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab || activeTab.id === undefined) {
      setStatus("アクティブなタブが見つかりません。");
      return;
    }

    if (!isSupportedUrl(activeTab.url)) {
      setStatus("x.com または twitter.com のページで実行してください。");
      return;
    }

    chrome.tabs.sendMessage(
      activeTab.id,
      { type: "START_FETCH", targetCount, keyword: topicKeyword },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus("content scriptに接続できません。ページを再読み込みしてください。");
          return;
        }

        if (!response?.ok) {
          setStatus(`開始に失敗しました: ${response?.error || "unknown error"}`);
          return;
        }

        setStatus(`取得を開始しました（目標: ${targetCount}件 / キーワード: ${topicKeyword}）。完了後、ページ内に結果ウィンドウを表示します。`);
      }
    );
  } catch (error) {
    setStatus(`エラー: ${String(error)}`);
  } finally {
    startButton.disabled = false;
  }
});

loadSavedSettings();

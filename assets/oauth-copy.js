const promptText = document.getElementById("codex-prompt");
const copyButton = document.getElementById("copy-prompt");
const feedback = document.getElementById("copy-feedback");

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(promptText.textContent);
    feedback.textContent = "已复制，粘贴给本机 Codex 即可。";
  } catch {
    feedback.textContent = "复制失败，请手动选中并复制上面的文字。";
  }
});
copyButton.hidden = false;

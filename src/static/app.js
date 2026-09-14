// theqairubook — tiny progressive enhancement. Every form works without JS.

// Confirm destructive actions: <form data-confirm="Sure?">
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement && form.dataset.confirm && !confirm(form.dataset.confirm)) {
    e.preventDefault();
  }
});

// Votes without a page reload.
document.addEventListener("click", async (e) => {
  const button = e.target instanceof Element ? e.target.closest(".vote button") : null;
  if (!button || button.disabled) return;
  const form = button.closest("form");
  e.preventDefault();
  const data = new FormData(form);
  data.set("dir", button.value);
  form.classList.add("busy");
  try {
    const res = await fetch(form.action, {
      method: "POST",
      body: data,
      headers: { Accept: "application/json" },
    });
    const json = await res.json();
    if (json.ok) {
      form.querySelector(".vote-score").textContent = json.score;
      form.dataset.vote = json.myVote;
      form.querySelector(".vote-up").classList.toggle("on", json.myVote === 1);
      form.querySelector(".vote-down").classList.toggle("on", json.myVote === -1);
    } else if (json.error === "login") {
      location.href = "/login";
    }
  } catch {
    form.submit();
  } finally {
    form.classList.remove("busy");
  }
});

// Copy buttons: <button data-copy="#input">
document.addEventListener("click", async (e) => {
  const button = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
  if (!button) return;
  const input = document.querySelector(button.dataset.copy);
  if (!input) return;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    document.execCommand("copy");
  }
  const label = button.textContent;
  button.textContent = "Copied!";
  setTimeout(() => (button.textContent = label), 1500);
});

document.addEventListener("click", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.hasAttribute("data-select-on-click")) {
    e.target.select();
  }
});

// Live chat: poll for new messages and send without reloading.
const chat = document.getElementById("chat");
const chatForm = document.getElementById("chat-form");
if (chat && chatForm) {
  const bottom = document.getElementById("bottom");
  const scrollDown = () => (chat.scrollTop = chat.scrollHeight);
  scrollDown();

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const res = await fetch(`${chat.dataset.poll}?after=${chat.dataset.lastId}`);
      if (res.ok) {
        const html = await res.text();
        const lastId = res.headers.get("x-last-id");
        if (html.trim()) {
          const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
          chat.querySelector(".chat-empty")?.remove();
          bottom.insertAdjacentHTML("beforebegin", html);
          if (nearBottom) scrollDown();
        }
        if (lastId) chat.dataset.lastId = lastId;
      }
    } finally {
      polling = false;
    }
  };
  setInterval(() => {
    if (!document.hidden) poll();
  }, 3000);

  const textarea = chatForm.querySelector("textarea");
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = textarea.value.trim();
    if (!body) return;
    const data = new FormData(chatForm);
    textarea.value = "";
    try {
      const res = await fetch(chatForm.action, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("send failed");
      await poll();
      scrollDown();
    } catch {
      textarea.value = body;
      alert("Message didn't send. Check your connection and try again.");
    }
    textarea.focus();
  });
}

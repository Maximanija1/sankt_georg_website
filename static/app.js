(function () {
    "use strict";

    let sessionExpired = false;
    let lastSessionPing = 0;
    const SESSION_PING_THROTTLE_MS = 2000;

    function redirectToLogin() {
        if (sessionExpired) return;
        sessionExpired = true;
        window.location.href = "/login";
    }

    async function pingSession() {
        if (sessionExpired) return;
        const now = Date.now();
        if (now - lastSessionPing < SESSION_PING_THROTTLE_MS) return;
        lastSessionPing = now;
        try {
            const res = await fetch("/api/session", {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
                cache: "no-store",
            });
            if (res.status === 401) redirectToLogin();
        } catch (_e) { /* network error: ignore */ }
    }

    function filterTable() {
        const input = document.getElementById("searchInput");
        if (!input) return;
        const query = input.value.toLowerCase();
        const rows = document.querySelectorAll(".medication-row");
        rows.forEach(function (row) {
            const searchText = row.getAttribute("data-search") || "";
            row.style.display = searchText.includes(query) ? "" : "none";
        });
    }

    async function copyCodesForMedication(pzn, fromDate, toDate, btn) {
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Laden...";

        try {
            const params = new URLSearchParams({ pzn: pzn, from: fromDate, to: toDate });
            const response = await fetch("/api/codes/detail?" + params.toString(), {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (response.status === 401) {
                redirectToLogin();
                return;
            }
            const data = await response.json();
            const codes = data.codes || [];

            if (codes.length > 0) {
                await navigator.clipboard.writeText(
                    codes.map(function (c) { return c.code; }).join("\n")
                );

                const unmarkedIds = codes
                    .filter(function (c) { return !c.copied_at; })
                    .map(function (c) { return c.id; });

                if (unmarkedIds.length > 0) {
                    try {
                        await fetch("/api/codes/mark", {
                            method: "POST",
                            credentials: "same-origin",
                            headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                            body: JSON.stringify({ ids: unmarkedIds }),
                        });
                    } catch (_e) { /* silent */ }
                }

                const summaryRow = btn.closest("tr");
                const detailRow = summaryRow && summaryRow.nextElementSibling;
                if (detailRow && detailRow.classList.contains("med-detail-row")) {
                    const now = new Date().toISOString();
                    const fresh = codes.map(function (c) {
                        return {
                            id: c.id,
                            code: c.code,
                            copied_at: c.copied_at || now,
                            _checked: false,
                        };
                    });
                    detailRow._codes = fresh;
                    if (!detailRow.hasAttribute("hidden")) {
                        renderCodeList(detailRow, fresh);
                    }
                    refreshNeuBadge(summaryRow, fresh);
                }

                btn.textContent = "Kopiert!";
                btn.classList.add("copied");
                setTimeout(function () {
                    btn.textContent = originalText;
                    btn.classList.remove("copied");
                    btn.disabled = false;
                }, 2000);
            } else {
                btn.textContent = "Keine Codes";
                setTimeout(function () {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }, 2000);
            }
        } catch (err) {
            btn.textContent = "Fehler!";
            setTimeout(function () {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2000);
        }
    }

    // ---------- Modal (confirm / info) ----------

    let modalOverlay = null;
    let modalCard, modalTitle, modalMessage, modalCancel, modalOk;
    let modalPending = null;

    function buildModal() {
        modalOverlay = document.createElement("div");
        modalOverlay.className = "modal-overlay";
        modalOverlay.setAttribute("role", "dialog");
        modalOverlay.setAttribute("aria-modal", "true");

        modalCard = document.createElement("div");
        modalCard.className = "modal-card";

        const header = document.createElement("div");
        header.className = "modal-header";
        modalTitle = document.createElement("h3");
        header.appendChild(modalTitle);

        const body = document.createElement("div");
        body.className = "modal-body";
        modalMessage = document.createElement("p");
        body.appendChild(modalMessage);

        const footer = document.createElement("div");
        footer.className = "modal-footer";
        modalCancel = document.createElement("button");
        modalCancel.type = "button";
        modalCancel.className = "button-secondary";
        modalOk = document.createElement("button");
        modalOk.type = "button";
        footer.appendChild(modalCancel);
        footer.appendChild(modalOk);

        modalCard.appendChild(header);
        modalCard.appendChild(body);
        modalCard.appendChild(footer);
        modalOverlay.appendChild(modalCard);
        document.body.appendChild(modalOverlay);

        modalCancel.addEventListener("click", closeModal);
        modalOk.addEventListener("click", confirmModal);
        modalOverlay.addEventListener("click", function (e) {
            if (e.target === modalOverlay) closeModal();
        });
        document.addEventListener("keydown", function (e) {
            if (modalOverlay.classList.contains("visible") && e.key === "Escape") {
                closeModal();
            }
        });
    }

    function openModal(options) {
        if (!modalOverlay) buildModal();
        modalTitle.textContent = options.title || "Bestätigen";
        modalMessage.textContent = options.message || "";
        modalOk.textContent = options.okText || "Bestätigen";
        modalCancel.textContent = options.cancelText || "Abbrechen";
        modalCancel.hidden = !!options.infoOnly;
        modalCard.classList.toggle("modal-info", !!options.infoOnly);
        modalPending = options;
        modalOverlay.classList.add("visible");
        setTimeout(function () {
            (options.infoOnly ? modalOk : modalCancel).focus();
        }, 0);
    }

    function closeModal() {
        if (!modalOverlay) return;
        modalOverlay.classList.remove("visible");
        modalPending = null;
    }

    function confirmModal() {
        const p = modalPending;
        modalOverlay.classList.remove("visible");
        modalPending = null;
        if (p && typeof p.onConfirm === "function") p.onConfirm();
    }

    // ---------- Inline expand rows ----------

    function csrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : "";
    }

    function updateCopyBtn(detailRow, codes) {
        const btn = detailRow.querySelector(".btn-copy-selected");
        if (!btn) return;
        const n = codes.filter(function (c) { return c._checked; }).length;
        btn.disabled = n === 0;
        btn.textContent = n + " ausgewählt kopieren";
    }

    function renderCodeList(detailRow, codes) {
        const loading = detailRow.querySelector(".med-detail-loading");
        const list = detailRow.querySelector(".codes-list");
        if (!list) return;

        loading.hidden = true;
        list.hidden = false;
        list.innerHTML = "";

        codes.forEach(function (item, idx) {
            const isCopied = !!item.copied_at;
            const li = document.createElement("li");
            li.className = "code-item" + (isCopied ? " is-copied" : "");

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!item._checked;
            cb.disabled = isCopied;
            cb.id = "code-cb-" + detailRow.dataset.pzn + "-" + idx;

            const lbl = document.createElement("label");
            lbl.htmlFor = cb.id;
            lbl.className = "code-text";
            lbl.textContent = item.code;

            li.appendChild(cb);
            li.appendChild(lbl);

            if (!isCopied) {
                li.addEventListener("click", function (e) {
                    if (e.target === cb) return;
                    cb.checked = !cb.checked;
                    item._checked = cb.checked;
                    updateCopyBtn(detailRow, codes);
                });
                cb.addEventListener("change", function () {
                    item._checked = cb.checked;
                    updateCopyBtn(detailRow, codes);
                });
            }

            list.appendChild(li);
        });

        updateCountInputMax(detailRow, codes);
        updateCopiedCounter(detailRow, codes);
        updateCopyBtn(detailRow, codes);
    }

    function availableCount(codes) {
        return codes.filter(function (c) { return !c.copied_at; }).length;
    }

    function updateCountInputMax(detailRow, codes) {
        const input = detailRow.querySelector(".codes-count-input");
        if (!input) return;
        const max = availableCount(codes);
        input.max = max;
        input.disabled = max === 0;
        if (input.value) {
            const n = parseInt(input.value, 10);
            if (n > max) input.value = max > 0 ? max : "";
        }
    }

    function updateCopiedCounter(detailRow, codes) {
        const el = detailRow.querySelector(".codes-copied-count");
        if (!el) return;
        const total = codes.length;
        const copied = codes.filter(function (c) { return c.copied_at; }).length;
        const open = total - copied;
        el.textContent = copied + " von " + total + " kopiert · " + open + " offen";
    }

    async function openDetailRow(summaryRow, detailRow) {
        const pzn = detailRow.dataset.pzn || "";
        const from = detailRow.dataset.from;
        const to = detailRow.dataset.to;

        const loading = detailRow.querySelector(".med-detail-loading");
        const list = detailRow.querySelector(".codes-list");
        loading.hidden = false;
        loading.textContent = "Laden...";
        list.hidden = true;
        list.innerHTML = "";
        detailRow.querySelector(".codes-count-input").value = "";
        updateCopyBtn(detailRow, []);

        detailRow._codes = [];

        try {
            const params = new URLSearchParams({ pzn: pzn, from: from, to: to });
            const res = await fetch("/api/codes/detail?" + params.toString(), {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (res.status === 401) { redirectToLogin(); return; }
            const data = await res.json();
            detailRow._codes = (data.codes || []).map(function (c) {
                return { id: c.id, code: c.code, copied_at: c.copied_at, _checked: false };
            });
        } catch (_e) {
            loading.textContent = "Fehler beim Laden.";
            return;
        }

        renderCodeList(detailRow, detailRow._codes);
    }

    function refreshNeuBadge(summaryRow, codes) {
        const badge = summaryRow.querySelector(".badge-neu");
        const maxCopiedAt = codes.reduce(function (max, c) {
            return c.copied_at && (!max || c.copied_at > max) ? c.copied_at : max;
        }, null);
        const newCount = maxCopiedAt
            ? codes.filter(function (c) { return !c.copied_at && c.scanned_at > maxCopiedAt; }).length
            : 0;
        if (badge) badge.textContent = newCount > 0 ? newCount + " neu" : "";
        if (badge) badge.hidden = newCount === 0;
    }

    function initExpandRows() {
        document.querySelectorAll(".med-summary").forEach(function (summaryRow) {
            const detailRow = summaryRow.nextElementSibling;
            if (!detailRow || !detailRow.classList.contains("med-detail-row")) return;

            summaryRow.addEventListener("click", function (e) {
                if (e.target.closest(".btn-copy")) return;
                const isOpen = !detailRow.hasAttribute("hidden");
                if (isOpen) {
                    detailRow.setAttribute("hidden", "");
                    summaryRow.classList.remove("expanded");
                } else {
                    detailRow.removeAttribute("hidden");
                    summaryRow.classList.add("expanded");
                    openDetailRow(summaryRow, detailRow);
                }
            });

            const countInput = detailRow.querySelector(".codes-count-input");
            countInput.addEventListener("input", function () {
                const codes = detailRow._codes || [];
                const max = availableCount(codes);
                const n = parseInt(countInput.value, 10);
                if (!isNaN(n) && n > max) countInput.value = max;
                if (!isNaN(n) && n < 1) countInput.value = "";
            });

            detailRow.querySelector(".btn-select-n").addEventListener("click", function () {
                const codes = detailRow._codes || [];
                const max = availableCount(codes);
                let n = parseInt(countInput.value, 10);
                if (!n || n < 1) return;
                if (n > max) n = max;
                let remaining = n;
                codes.forEach(function (c) {
                    if (!c.copied_at && remaining > 0) {
                        c._checked = true;
                        remaining--;
                    } else {
                        c._checked = false;
                    }
                });
                renderCodeList(detailRow, codes);
            });

            detailRow.querySelector(".btn-copy-selected").addEventListener("click", async function (e) {
                e.stopPropagation();
                const btn = this;
                const codes = detailRow._codes || [];
                const selected = codes.filter(function (c) { return c._checked; });
                if (!selected.length) return;

                try {
                    await navigator.clipboard.writeText(selected.map(function (c) { return c.code; }).join("\n"));
                } catch (_e) {
                    btn.textContent = "Kopieren fehlgeschlagen";
                    return;
                }

                try {
                    await fetch("/api/codes/mark", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                        body: JSON.stringify({ ids: selected.map(function (c) { return c.id; }) }),
                    });
                } catch (_e) { /* silent */ }

                const now = new Date().toISOString();
                selected.forEach(function (c) { c.copied_at = now; c._checked = false; });

                btn.textContent = "Kopiert!";
                btn.classList.add("copied");
                renderCodeList(detailRow, codes);
                refreshNeuBadge(summaryRow, codes);
                setTimeout(function () { btn.classList.remove("copied"); }, 2000);
            });

            detailRow.querySelector(".btn-reset-copied").addEventListener("click", function (e) {
                e.stopPropagation();
                openModal({
                    title: "Zurücksetzen bestätigen",
                    message: "Alle kopierten Markierungen zurücksetzen?",
                    okText: "Zurücksetzen",
                    onConfirm: async function () {
                        const pzn = detailRow.dataset.pzn || "";
                        const from = detailRow.dataset.from;
                        const to = detailRow.dataset.to;

                        try {
                            await fetch("/api/codes/reset", {
                                method: "POST",
                                credentials: "same-origin",
                                headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                                body: JSON.stringify({ pzn: pzn, from: from, to: to }),
                            });
                        } catch (_e) { /* silent */ }

                        const codes = detailRow._codes || [];
                        codes.forEach(function (c) { c.copied_at = null; c._checked = false; });
                        renderCodeList(detailRow, codes);
                        refreshNeuBadge(summaryRow, codes);

                        openModal({
                            title: "Zurückgesetzt",
                            message: "Alle Markierungen wurden zurückgesetzt.",
                            okText: "OK",
                            infoOnly: true,
                        });
                    },
                });
            });
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        const searchInput = document.getElementById("searchInput");
        if (searchInput) {
            searchInput.addEventListener("input", filterTable);
        }

        document.querySelectorAll(".btn-copy").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const pzn = btn.dataset.pzn || "";
                if (btn.dataset.from && btn.dataset.to) {
                    copyCodesForMedication(pzn, btn.dataset.from, btn.dataset.to, btn);
                }
            });
        });

        initExpandRows();

        ["pointerdown", "keydown", "input", "change", "copy", "paste", "cut"].forEach(
            function (evt) {
                document.addEventListener(evt, pingSession, { capture: true, passive: true });
            }
        );
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") pingSession();
        });
    });
})();

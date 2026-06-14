(function () {
    "use strict";

    let sessionExpired = false;
    let lastSessionPing = 0;
    const SESSION_PING_THROTTLE_MS = 2000;

    // ---- Idle session countdown (mirrors server IDLE_LIMIT_SECONDS) ----
    const IDLE_KEY = "sb_idle_deadline";
    let idleLimitMs = 30 * 60 * 1000;   // overridden from #sessionTimer data-idle-seconds
    let idleDeadline = Date.now() + idleLimitMs;
    let idleWriteAt = 0;
    let idleVerifying = false;

    function redirectToLogin() {
        if (sessionExpired) return;
        sessionExpired = true;
        window.location.href = "/login";
    }

    function resetIdleTimer() {
        idleDeadline = Date.now() + idleLimitMs;
        const now = Date.now();
        // Share the deadline with other tabs (throttled to avoid spamming writes).
        if (now - idleWriteAt > 1000) {
            idleWriteAt = now;
            try { localStorage.setItem(IDLE_KEY, String(idleDeadline)); } catch (_e) { /* ignore */ }
        }
    }

    function formatIdle(ms) {
        if (ms < 0) ms = 0;
        const total = Math.ceil(ms / 1000);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m + ":" + (s < 10 ? "0" + s : s);
    }

    // Reached zero locally — confirm with the server before logging out, in case
    // another tab kept the session alive.
    async function verifyOrExpire() {
        try {
            const res = await fetch("/api/session", {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
                cache: "no-store",
            });
            if (res.status === 401) { redirectToLogin(); return; }
            resetIdleTimer();
        } catch (_e) { /* network error: retry on next tick */ }
        idleVerifying = false;
    }

    function tickIdle() {
        const el = document.getElementById("sessionTimer");
        if (!el) return;
        const remaining = idleDeadline - Date.now();
        if (remaining <= 0) {
            if (!idleVerifying) { idleVerifying = true; verifyOrExpire(); }
            return;
        }
        const timeEl = el.querySelector(".session-timer-time") || el;
        timeEl.textContent = formatIdle(remaining);
        el.classList.toggle("warning", remaining <= 2 * 60 * 1000);
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

        document.querySelectorAll(".medication-row").forEach(function (row) {
            const searchText = row.getAttribute("data-search") || "";
            const match = searchText.includes(query);
            row.style.display = match ? "" : "none";
            const detail = row.nextElementSibling;
            if (detail && detail.classList.contains("med-detail-row")) {
                detail.style.display = match ? "" : "none";
            }
        });

        document.querySelectorAll(".session-group").forEach(function (group) {
            const hasVisible = Array.from(
                group.querySelectorAll(".medication-row")
            ).some(function (r) { return r.style.display !== "none"; });
            group.style.display = hasVisible ? "" : "none";
        });
    }

    async function copyCodesForMedication(pzn, fromDate, toDate, btn) {
        const originalText = btn.textContent;
        const sessionAt = btn.dataset.sessionAt || "";
        btn.disabled = true;
        btn.textContent = "Laden...";

        try {
            const params = new URLSearchParams({ pzn: pzn, from: fromDate, to: toDate });
            if (sessionAt) params.set("session_at", sessionAt);
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
                const now = new Date().toISOString();
                const fresh = codes.map(function (c) {
                    return {
                        id: c.id,
                        code: c.code,
                        copied_at: c.copied_at || now,
                        _checked: false,
                    };
                });
                if (detailRow && detailRow.classList.contains("med-detail-row")) {
                    detailRow._codes = fresh;
                    if (!detailRow.hasAttribute("hidden")) {
                        renderCodeList(detailRow, fresh);
                    }
                    refreshNeuBadge(summaryRow, fresh);
                }
                if (summaryRow) updateAllCopiedTick(summaryRow, fresh);

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
        const sessionAt = detailRow.dataset.sessionAt || "";

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
            if (sessionAt) params.set("session_at", sessionAt);
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
        updateAllCopiedTick(summaryRow, detailRow._codes);
    }

    function updateAllCopiedTick(summaryRow, codes) {
        if (!summaryRow) return;
        const tick = summaryRow.querySelector(".all-copied-tick");
        if (!tick) return;
        const total = codes.length;
        if (total === 0) { tick.hidden = true; return; }
        tick.hidden = !codes.every(function (c) { return !!c.copied_at; });
    }

    async function copyPznText(btn) {
        const pzn = btn.dataset.pzn || "";
        if (!pzn) return;
        try {
            await navigator.clipboard.writeText(pzn);
            btn.classList.add("copied");
            setTimeout(function () { btn.classList.remove("copied"); }, 1500);
        } catch (_e) { /* silent */ }
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

    // ---------- Delete medication (Heute) ----------

    function recountTodayTotals() {
        const rows = document.querySelectorAll(".medication-row");
        let totalCodes = 0;
        rows.forEach(function (r) {
            const badge = r.querySelector(".count-badge");
            if (badge) totalCodes += parseInt(badge.textContent, 10) || 0;
        });
        const groups = Array.from(document.querySelectorAll(".session-group"))
            .filter(function (g) { return g.querySelector(".medication-row"); });
        const summary = document.querySelector(".summary");
        if (summary) {
            summary.innerHTML =
                "Gesamt: <strong>" + totalCodes + "</strong> Codes bei <strong>" +
                rows.length + "</strong> Medikamenten in <strong>" +
                groups.length + "</strong> Lieferscheinen";
        }
    }

    function renumberRows() {
        document.querySelectorAll(".fixed-table tbody").forEach(function (tbody) {
            let i = 0;
            tbody.querySelectorAll(".medication-row").forEach(function (row) {
                i += 1;
                const cell = row.querySelector("td:nth-child(2) strong");
                if (cell) cell.textContent = i;
            });
        });
        let n = 0;
        document.querySelectorAll(".session-group").forEach(function (group) {
            n += 1;
            const label = group.querySelector(".session-label");
            if (label) label.textContent = "Lieferschein " + n;
        });
    }

    function removeMedicationRow(summaryRow) {
        if (!summaryRow) { window.location.reload(); return; }
        const group = summaryRow.closest(".session-group");
        const detailRow = summaryRow.nextElementSibling;
        if (detailRow && detailRow.classList.contains("med-detail-row")) {
            detailRow.remove();
        }
        summaryRow.remove();
        if (group && !group.querySelector(".medication-row")) {
            group.remove();
        }
        // Nothing left at all — reload so the empty-state view renders cleanly.
        if (!document.querySelector(".medication-row")) {
            window.location.reload();
            return;
        }
        renumberRows();
        recountTodayTotals();
    }

    function deleteMedication(btn, summaryRow) {
        const pzn = btn.dataset.pzn || "";
        const from = btn.dataset.from || "";
        const to = btn.dataset.to || "";
        const sessionAt = btn.dataset.sessionAt || "";
        const name = btn.dataset.name || "dieses Medikament";
        if (!from || !to) return;

        openModal({
            title: "Medikament löschen",
            message: "„" + name + "“ und alle zugehörigen Codes endgültig löschen? "
                + "Die Codes können danach erneut gescannt werden.",
            okText: "Löschen",
            cancelText: "Abbrechen",
            onConfirm: async function () {
                try {
                    const body = { pzn: pzn, from: from, to: to };
                    if (sessionAt) body.session_at = sessionAt;
                    const res = await fetch("/api/codes/delete", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                        body: JSON.stringify(body),
                    });
                    if (res.status === 401) { redirectToLogin(); return; }
                    if (!res.ok) throw new Error("delete_failed");
                } catch (_e) {
                    openModal({
                        title: "Fehler",
                        message: "Löschen fehlgeschlagen. Bitte erneut versuchen.",
                        okText: "OK",
                        infoOnly: true,
                    });
                    return;
                }
                removeMedicationRow(summaryRow);
            },
        });
    }

    function initExpandRows() {
        document.querySelectorAll(".med-summary").forEach(function (summaryRow) {
            const detailRow = summaryRow.nextElementSibling;
            if (!detailRow || !detailRow.classList.contains("med-detail-row")) return;

            summaryRow.addEventListener("click", function (e) {
                if (e.target.closest(".btn-copy")
                    || e.target.closest(".btn-copy-pzn")
                    || e.target.closest(".action-menu")) return;
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
                updateAllCopiedTick(summaryRow, codes);
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
                        const sessionAt = detailRow.dataset.sessionAt || "";

                        try {
                            const body = { pzn: pzn, from: from, to: to };
                            if (sessionAt) body.session_at = sessionAt;
                            await fetch("/api/codes/reset", {
                                method: "POST",
                                credentials: "same-origin",
                                headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
                                body: JSON.stringify(body),
                            });
                        } catch (_e) { /* silent */ }

                        const codes = detailRow._codes || [];
                        codes.forEach(function (c) { c.copied_at = null; c._checked = false; });
                        renderCodeList(detailRow, codes);
                        refreshNeuBadge(summaryRow, codes);
                        updateAllCopiedTick(summaryRow, codes);

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

        document.querySelectorAll(".btn-copy-pzn").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                copyPznText(btn);
            });
        });

        let currentBtn = null;
        let currentPopover = null;

        function positionMenu() {
            if (!currentBtn || !currentPopover) return;
            const rect = currentBtn.getBoundingClientRect();
            if (rect.bottom < 0 || rect.top > window.innerHeight) {
                hideMenu();
                return;
            }
            const w = currentPopover.offsetWidth;
            currentPopover.style.top = (rect.bottom + 6) + "px";
            currentPopover.style.left = (rect.right - w) + "px";
        }

        function showMenu(btn, popover) {
            currentBtn = btn;
            currentPopover = popover;
            popover.hidden = false;
            positionMenu();
            btn.setAttribute("aria-expanded", "true");
        }

        function hideMenu() {
            if (currentPopover) currentPopover.hidden = true;
            if (currentBtn) currentBtn.setAttribute("aria-expanded", "false");
            currentBtn = null;
            currentPopover = null;
        }

        document.querySelectorAll(".btn-actions").forEach(function (btn) {
            const popover = btn.nextElementSibling;
            if (!popover || !popover.classList.contains("action-menu-popover")) return;
            // Move popover to body so it escapes the table's overflow:hidden clip
            document.body.appendChild(popover);

            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                if (currentBtn === btn) {
                    hideMenu();
                } else {
                    hideMenu();
                    showMenu(btn, popover);
                }
            });
        });

        async function markCodesForXmlDownload(params, summaryRow) {
            if (!params.from || !params.to) return;
            try {
                const qs = new URLSearchParams();
                qs.set("pzn", params.pzn || "");
                qs.set("from", params.from);
                qs.set("to", params.to);
                if (params.session_at) qs.set("session_at", params.session_at);
                const response = await fetch("/api/codes/detail?" + qs.toString(), {
                    credentials: "same-origin",
                    headers: { Accept: "application/json" },
                });
                if (response.status === 401) { redirectToLogin(); return; }
                const data = await response.json();
                const codes = data.codes || [];
                if (codes.length === 0) return;

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

                if (!summaryRow) return;
                const now = new Date().toISOString();
                const fresh = codes.map(function (c) {
                    return { id: c.id, code: c.code, copied_at: c.copied_at || now, _checked: false };
                });
                const detailRow = summaryRow.nextElementSibling;
                if (detailRow && detailRow.classList.contains("med-detail-row")) {
                    detailRow._codes = fresh;
                    if (!detailRow.hasAttribute("hidden")) {
                        renderCodeList(detailRow, fresh);
                    }
                    refreshNeuBadge(summaryRow, fresh);
                }
                updateAllCopiedTick(summaryRow, fresh);
            } catch (_e) { /* silent */ }
        }

        document.addEventListener("click", function (e) {
            const dlItem = e.target.closest(".action-menu-item[data-action='download-xml']");
            if (dlItem) {
                const summaryRow = currentBtn ? currentBtn.closest("tr") : null;
                try {
                    const url = new URL(dlItem.href, window.location.origin);
                    markCodesForXmlDownload({
                        pzn: url.searchParams.get("pzn") || "",
                        from: url.searchParams.get("from") || "",
                        to: url.searchParams.get("to") || "",
                        session_at: url.searchParams.get("session_at") || "",
                    }, summaryRow);
                } catch (_e) { /* silent */ }
            }
            const delItem = e.target.closest(".action-menu-item[data-action='delete-medication']");
            if (delItem) {
                const summaryRow = currentBtn ? currentBtn.closest("tr") : null;
                deleteMedication(delItem, summaryRow);
            }
            hideMenu();
        });
        window.addEventListener("scroll", positionMenu, { passive: true });
        window.addEventListener("resize", function () { hideMenu(); });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") hideMenu();
        });

        initExpandRows();

        const timerEl = document.getElementById("sessionTimer");
        if (timerEl) {
            const secs = parseInt(timerEl.dataset.idleSeconds, 10);
            if (!isNaN(secs) && secs > 0) idleLimitMs = secs * 1000;
            resetIdleTimer();
            tickIdle();
            setInterval(tickIdle, 1000);
            window.addEventListener("storage", function (e) {
                if (e.key === IDLE_KEY && e.newValue) {
                    const v = parseInt(e.newValue, 10);
                    if (!isNaN(v) && v > idleDeadline) idleDeadline = v;
                }
            });
        }

        function onActivity() {
            pingSession();
            resetIdleTimer();
        }
        ["pointerdown", "keydown", "input", "change", "copy", "paste", "cut"].forEach(
            function (evt) {
                document.addEventListener(evt, onActivity, { capture: true, passive: true });
            }
        );
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") {
                pingSession();
                resetIdleTimer();
                tickIdle();
            }
        });
    });
})();

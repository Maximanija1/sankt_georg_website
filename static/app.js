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
            const response = await fetch("/api/codes?" + params.toString(), {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (response.status === 401) {
                redirectToLogin();
                return;
            }
            const data = await response.json();

            if (data.codes && data.codes.length > 0) {
                await navigator.clipboard.writeText(data.codes.join("\n"));
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
            const li = document.createElement("li");
            li.className = "code-item" + (item.copied_at ? " is-copied" : "");

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!item._checked;
            cb.id = "code-cb-" + detailRow.dataset.pzn + "-" + idx;

            const lbl = document.createElement("label");
            lbl.htmlFor = cb.id;
            lbl.className = "code-text";
            lbl.textContent = item.code;

            li.appendChild(cb);
            li.appendChild(lbl);

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

            list.appendChild(li);
        });

        updateCopyBtn(detailRow, codes);
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

            detailRow.querySelector(".btn-select-n").addEventListener("click", function () {
                const n = parseInt(detailRow.querySelector(".codes-count-input").value, 10);
                if (!n || n < 1) return;
                const codes = detailRow._codes || [];
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

            detailRow.querySelector(".btn-reset-copied").addEventListener("click", async function (e) {
                e.stopPropagation();
                if (!confirm("Alle kopierten Markierungen zurücksetzen?")) return;
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

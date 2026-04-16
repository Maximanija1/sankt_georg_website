(function () {
    "use strict";

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

    function copyCodesForDate(pzn, dateStr, btn) {
        const dt = new Date(dateStr + "T05:00:00+02:00");
        const nextDt = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
        copyCodesForMedication(pzn, dt.toISOString(), nextDt.toISOString(), btn);
    }

    document.addEventListener("DOMContentLoaded", function () {
        const searchInput = document.getElementById("searchInput");
        if (searchInput) {
            searchInput.addEventListener("input", filterTable);
        }

        document.querySelectorAll(".btn-copy").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const pzn = btn.dataset.pzn || "";
                if (btn.dataset.date) {
                    copyCodesForDate(pzn, btn.dataset.date, btn);
                } else if (btn.dataset.from && btn.dataset.to) {
                    copyCodesForMedication(pzn, btn.dataset.from, btn.dataset.to, btn);
                }
            });
        });
    });
})();

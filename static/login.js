(function () {
    "use strict";

    var modal = document.getElementById("session-expired-modal");
    if (!modal) return;

    var dismissBtn = document.getElementById("session-expired-dismiss");
    var emailInput = document.getElementById("email");

    function dismiss() {
        modal.classList.remove("visible");
        if (emailInput) emailInput.focus();
    }

    dismissBtn.addEventListener("click", dismiss);

    modal.addEventListener("click", function (e) {
        if (e.target === modal) dismiss();
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && modal.classList.contains("visible")) {
            dismiss();
        }
    });

    setTimeout(function () { dismissBtn.focus(); }, 0);
}());

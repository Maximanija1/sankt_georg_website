(function () {
    "use strict";

    var expired = document.querySelector(".flash-session_expired");
    if (!expired) return;

    var emailInput = document.getElementById("email");
    if (emailInput) emailInput.focus();
}());

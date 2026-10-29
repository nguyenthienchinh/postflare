// Shows the status of a Meta data deletion request (/data-deletion/?code=...). External file: the page CSP has no inline scripts.
(function () {
  var code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  var box = document.getElementById("status");
  var text = document.getElementById("status-text");
  box.hidden = false;
  var day = function (ms) {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  };
  var say = function (s) {
    text.textContent = s; // textContent: nothing from the URL or the server is parsed as HTML.
  };
  fetch("/oauth/meta/data-deletion/status?code=" + encodeURIComponent(code), { headers: { accept: "application/json" } })
    .then(function (res) {
      if (res.status === 404) return say("No deletion request was found for confirmation code " + code + ". Requests are kept for 90 days.");
      if (!res.ok) throw new Error(String(res.status));
      return res.json().then(function (r) {
        var head = "Confirmation code " + code + ": request received " + day(r.requestedAt) + ". ";
        say(
          r.status === "completed"
            ? head + "Completed " + day(r.completedAt) + ": " + r.accounts + " connected account" + (r.accounts === 1 ? " was" : "s were") + " removed with their tokens, profile data, posts and metrics."
            : head + "Completed " + day(r.completedAt) + ": this instance held no data for you.",
        );
      });
    })
    .catch(function () {
      say("The status could not be loaded. Please try again later.");
    });
})();

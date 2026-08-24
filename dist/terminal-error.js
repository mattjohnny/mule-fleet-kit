// The terminal error handler: the last middleware in the stack, and the one
// that actually answers a caller whose request ended in an exception.
//
// Seven apps carried a copy of this, which is the drift this package exists to
// end: seven places for the same three decisions to be made differently, and
// three ways for a copy to get one wrong. Putting the error's own words in the
// response body. Answering nothing and letting Express's default handler have
// it, which prints the stack into the response body anywhere but production.
// Deriving a status separately from the one the log line recorded, so the
// incident in the log source is not the incident the caller experienced.
//
// NOTHING IS LOGGED FROM THIS FILE. `installErrorTelemetry` logged this exact
// error one middleware ago, hygienically — an allow-listed name plus a code
// location. A second line here could only add the part that must never be
// emitted, and two lines per failure is how a log source stops being read.
//
// So this brick's whole job is: decide the status, say one of three fixed
// sentences, and never let the error reach Express's default handler.
import { intendedStatus } from "./errors.js";
/**
 * The only three things this fleet says to a caller about a failed request.
 *
 * THE 4xx CASE IS THE ONE THAT MATTERS. A 4xx feels safe to explain — the caller
 * caused it, so surely they may see why. But the commonest 4xx in this fleet is
 * `express.json()` refusing a malformed body, and that error carries the payload
 * twice over: V8 quotes a snippet of the input in the message itself
 * (`Unexpected token 'o', "not json" is not valid JSON`), and body-parser
 * attaches the whole raw body to the error object, where any `JSON.stringify` of
 * it would pick it up. Explaining a bad request means reflecting the request
 * back out, and request bodies here hold staff names and wages. So no branch
 * reads the error, not even for a 4xx.
 *
 * 413 is split out because it is the one client error a person can act on: the
 * upload is too big, try a smaller one. Everything else 4xx is deliberately
 * vague, and 5xx says "it's been logged" because it has been — that sentence is
 * true, and it is the one that stops a person retrying a broken thing all day.
 */
function houseMessage(status) {
    if (status === 413)
        return "That upload is too large.";
    if (status < 500)
        return "That request couldn't be read.";
    return "Something went wrong on our side — it's been logged.";
}
/**
 * Install the fleet's terminal error handler. Two things happen here.
 *
 * 1. `x-powered-by` is disabled. Express advertises itself in a header on every
 *    response, which is a free hint to anyone scanning the fleet for a framework
 *    with a known advisory. It is turned off here rather than in fourteen app
 *    bootstraps because this is the call every app is adding anyway (job 26,
 *    cluster 4 in mule-fleet-docs). It applies to successful responses too — the
 *    setting is read per response, not per handler.
 *
 * 2. The terminal 4-arg error middleware is registered. It answers with the
 *    house JSON `{ "error": "..." }` and never emits `error.message` or
 *    `error.stack` — see `houseMessage`, and the file header for why nothing is
 *    logged here either.
 *
 * INSTALL IT LAST, after the routes, after `installErrorTelemetry`, and after
 * any error handler of the app's own. Express runs middleware in registration
 * order, so anything registered later than a handler that sends a response never
 * runs at all. An app that already has a terminal handler it wants to keep
 * simply does not call this.
 *
 * THE HEADERS-SENT BRANCH IS NOT A FORMALITY. When a route has already written
 * part of a response and then fails — a streamed export that throws halfway
 * through the rows — the status line is long gone, so there is nothing to answer
 * with. Calling `res.json()` there throws `ERR_HTTP_HEADERS_SENT`, and passing
 * the error on with `next(error)` hands it to Express's default handler, which
 * responds by printing the stack to stderr — unstructured, unredacted, straight
 * past every guarantee this package makes. Destroying the socket is the honest
 * outcome: the client gets a truncated response and knows the body is
 * incomplete, which is true, and nothing leaks on the way out.
 */
export function installTerminalErrorHandler(app) {
    app.disable("x-powered-by");
    app.use((error, _req, res, _next) => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        const status = intendedStatus(error, res);
        res.status(status).json({ error: houseMessage(status) });
    });
}

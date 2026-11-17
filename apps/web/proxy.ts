import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = ["/play", "/game", "/friends", "/challenges", "/settings", "/history", "/review", "/improve"];
const AUTH_PAGES = ["/login", "/register"];

/**
 * Lightweight routing guard. It only checks for the presence of the session cookie; real
 * validation happens in server components via `getSession()`.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has("tempo.session_token") || request.cookies.has("__Secure-tempo.session_token");
  if (!hasSession && PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  if (hasSession && AUTH_PAGES.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icons|pieces|manifest.webmanifest|sw.js).*)"],
};

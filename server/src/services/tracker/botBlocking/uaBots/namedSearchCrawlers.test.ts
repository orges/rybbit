/**
 * The new named search-crawler patterns, checked against the user agents those
 * crawlers actually send. Guards the annotations against being unreachable: a
 * pattern that no real UA matches would pass the regression replay and still be
 * dead weight.
 */
import { describe, expect, it } from "vitest";
import { classifyUA } from "./index.js";

const named = (ua: string) => {
  const result = classifyUA(ua);
  return { isBot: result.isBot, name: result.name, operator: result.operator, purpose: result.purpose };
};

describe("named search crawlers", () => {
  it("names the large search engines that had only a loose substring rule", () => {
    expect(named("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toEqual({
      isBot: true,
      name: "Googlebot",
      operator: "Google",
      purpose: "search",
    });
    // Bingbot is caught, but by the vendored `bots?` rule that runs before this
    // list can reach it — so it stays unnamed. Asserting the detection rather
    // than the name keeps a future reordering from looking like a regression.
    expect(classifyUA("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)").isBot).toBe(true);
    expect(named("Mozilla/5.0 (compatible; msnbot/2.0b; +http://search.msn.com/msnbot.htm)").name).toBe("Bingbot");
    expect(named("Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)").name).toBe(
      "Baiduspider"
    );
    expect(named("Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)").name).toBe("Sogou");
    expect(named("Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)").name).toBe(
      "PetalBot"
    );
    expect(named("Mozilla/5.0 (compatible; SeznamBot/4.0)").name).toBe("SeznamBot");
    expect(named("Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)").isBot).toBe(true);
    expect(named("Mozilla/5.0 (compatible; yeti.naver/1.0)").name).toBe("Yeti");
    expect(named("Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html)").name).toBe("Daum");
    expect(named("Mozilla/5.0 (compatible; MojeekBot/0.11; +http://www.mojeek.com/bot.html)").name).toBe("MojeekBot");
  });

  it("still names the ones that already worked", () => {
    expect(named("DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)").name).toBe("DuckDuckBot");
    expect(named("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)").name).toBe("YandexBot");
    expect(named("Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)").name).toBe(
      "Yahoo! Slurp"
    );
  });

  it("does not name ordinary browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0",
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
    ]) {
      expect(classifyUA(ua).isBot, ua).toBe(false);
    }
  });

  /**
   * `yeti` was the one loose token worth guarding: "Yeti" is the name of a real
   * Android browser engine and ships in the user agent of ordinary phones, so a
   * bare `\\byeti\\b` would have convicted them. The rule is anchored on
   * `yeti.naver` instead, and this is the UA that motivated that.
   */
  it("does not convict a browser whose UA merely contains a crawler word", () => {
    expect(
      classifyUA(
        "Mozilla/5.0 (Linux; Android 11;motorola edge) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 Yeti/2.0"
      ).isBot
    ).toBe(false);
  });

  it("still catches the AI crawlers ahead of the new search rules", () => {
    expect(
      named("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot")
    ).toEqual({
      isBot: true,
      name: "GPTBot",
      operator: "OpenAI",
      purpose: "ai_training",
    });
    expect(named("ClaudeBot/1.0").purpose).toBe("ai_training");
    expect(named("Mozilla/5.0 (compatible; Google-Extended)").purpose).toBe("ai_training");
  });
});

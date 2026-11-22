package polka.mobile;

import java.util.Objects;

public final class SharedVideoLinkTest {
    private static int checks;

    private static void expect(String text, String expected) {
        String actual = SharedVideoLink.find(text);
        if (!Objects.equals(actual, expected)) throw new AssertionError(text + " → " + actual);
        checks++;
    }

    public static void main(String[] args) {
        expect("Посмотри: https://youtu.be/M7lc1UVf-VE?si=shared", "https://youtu.be/M7lc1UVf-VE?si=shared");
        expect("Название\nhttps://www.youtube.com/watch?v=M7lc1UVf-VE&feature=shared", "https://www.youtube.com/watch?v=M7lc1UVf-VE&feature=shared");
        expect("«https://youtube.com/shorts/M7lc1UVf-VE».", "https://youtube.com/shorts/M7lc1UVf-VE");
        expect("(https://m.youtube.com/live/M7lc1UVf-VE)", "https://m.youtube.com/live/M7lc1UVf-VE");
        expect("https://music.youtube.com/watch?feature=share&v=M7lc1UVf-VE", "https://music.youtube.com/watch?feature=share&v=M7lc1UVf-VE");
        expect("https://example.com https://youtu.be/M7lc1UVf-VE", "https://youtu.be/M7lc1UVf-VE");
        expect("https://youtube.com/@channel https://youtu.be/M7lc1UVf-VE", "https://youtu.be/M7lc1UVf-VE");
        expect("https://youtube.com/watch?%76=M7lc1UVf-VE", "https://youtube.com/watch?%76=M7lc1UVf-VE");
        expect(null, null);
        expect("Just a title", null);
        expect("content://media/external/video/media/123", null);
        expect("https://youtube.com.evil.test/watch?v=M7lc1UVf-VE", null);
        expect("https://youtube.com@evil.test/watch?v=M7lc1UVf-VE", null);
        expect("https://evil@youtube.com/watch?v=M7lc1UVf-VE", null);
        expect("https://youtube.com:444/watch?v=M7lc1UVf-VE", null);
        expect("https://youtube.com/watch?v=invalid", null);
        expect("https://youtube.com/playlist?list=example", null);
        expect("https://youtu.be", null);
        expect("https://youtu.be/", null);
        expect("https://youtube.com/watch?v=%invalid", null);
        expect("https://youtu.be/M7lc1UVf-VE?x=" + "a".repeat(2048), null);
        System.out.println("PASS: " + checks + " Android shared-link cases");
    }
}

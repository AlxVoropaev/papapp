package polka.mobile;

import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

import static java.nio.charset.StandardCharsets.UTF_8;

/** Resolves the Cloudflare Worker on the app's current network, with DNS-over-HTTPS as a fallback. */
final class WorkerDns {
    private static final int DNS_RESPONSE_LIMIT = 8192;

    interface Request<T, E extends Exception> {
        T send(HttpsURLConnection connection) throws IOException, E;
    }

    static <T, E extends Exception> T request(URI target, Request<T, E> request) throws IOException, E {
        try {
            return request.send((HttpsURLConnection) target.toURL().openConnection());
        } catch (UnknownHostException unavailable) {
            // The original request failed during DNS resolution, before sending its body.
            IOException failure = unavailable;
            for (String address : resolve(target.getHost())) {
                try {
                    return request.send(open(target, address));
                } catch (ConnectException refused) {
                    failure = refused;
                }
            }
            throw failure;
        }
    }

    private static List<String> resolve(String host) throws IOException {
        URL resolver = URI.create("https://dns.google/resolve?name=" + Uri.encode(host) + "&type=A").toURL();
        var connection = (HttpsURLConnection) resolver.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestProperty("Accept", "application/dns-json");
        try {
            if (connection.getResponseCode() != 200) throw new UnknownHostException(host);
            try (var input = connection.getInputStream(); var output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > DNS_RESPONSE_LIMIT) throw new UnknownHostException(host);
                    output.write(buffer, 0, count);
                }
                var response = new JSONObject(new String(output.toByteArray(), UTF_8));
                var answers = response.optJSONArray("Answer");
                List<String> addresses = new ArrayList<>();
                if (response.optInt("Status", -1) == 0 && answers != null) {
                    for (int i = 0; i < answers.length(); i++) {
                        var answer = answers.optJSONObject(i);
                        if (answer == null || answer.optInt("type") != 1) continue;
                        String address = answer.optString("data");
                        if (isIpv4(address) && !addresses.contains(address)) addresses.add(address);
                    }
                }
                if (addresses.isEmpty()) throw new UnknownHostException(host);
                return addresses;
            } catch (JSONException malformed) {
                throw new IOException("Invalid DNS response", malformed);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static boolean isIpv4(String address) {
        if (!address.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) return false;
        for (String octet : address.split("\\.")) {
            if (Integer.parseInt(octet) > 255) return false;
        }
        return true;
    }

    private static HttpsURLConnection open(URI target, String address) throws IOException {
        String host = target.getHost();
        String resource = target.getRawPath();
        if (target.getRawQuery() != null) resource += "?" + target.getRawQuery();
        URL endpoint = new URL("https", address, target.getPort(), resource);
        var connection = (HttpsURLConnection) endpoint.openConnection();
        connection.setRequestProperty("Host", host);
        var verifier = HttpsURLConnection.getDefaultHostnameVerifier();
        connection.setHostnameVerifier((ignored, session) -> verifier.verify(host, session));
        connection.setSSLSocketFactory(new NamedTlsFactory(connection.getSSLSocketFactory(), host));
        return connection;
    }

    private static final class NamedTlsFactory extends SSLSocketFactory {
        private final SSLSocketFactory delegate;
        private final String host;

        NamedTlsFactory(SSLSocketFactory delegate, String host) {
            this.delegate = delegate;
            this.host = host;
        }

        @Override public Socket createSocket(Socket socket, String ignored, int port, boolean autoClose)
                throws IOException {
            var tls = (SSLSocket) delegate.createSocket(socket, host, port, autoClose);
            try {
                var parameters = tls.getSSLParameters();
                parameters.setServerNames(java.util.Collections.singletonList(new SNIHostName(host)));
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                tls.setSSLParameters(parameters);
                tls.setSoTimeout(5000);
                // Android's HTTP client configures SNI from the URL after this factory returns.
                tls.startHandshake();
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, tls.getSession())) {
                    throw new SSLPeerUnverifiedException(host);
                }
                return tls;
            } catch (IOException | RuntimeException error) {
                try {
                    tls.close();
                } catch (IOException closeError) {
                    error.addSuppressed(closeError);
                }
                throw error;
            }
        }

        @Override public String[] getDefaultCipherSuites() { return delegate.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return delegate.getSupportedCipherSuites(); }

        @Override public Socket createSocket(String address, int port) throws IOException {
            return delegate.createSocket(address, port);
        }

        @Override public Socket createSocket(String address, int port, InetAddress localAddress, int localPort)
                throws IOException {
            return delegate.createSocket(address, port, localAddress, localPort);
        }

        @Override public Socket createSocket(InetAddress address, int port) throws IOException {
            return delegate.createSocket(address, port);
        }

        @Override public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort)
                throws IOException {
            return delegate.createSocket(address, port, localAddress, localPort);
        }
    }
}

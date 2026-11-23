package polka.mobile;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class NewVideoMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        NewVideoNotifications.tokenChanged(this, token);
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        NewVideoNotifications.receive(this, message.getData());
    }
}

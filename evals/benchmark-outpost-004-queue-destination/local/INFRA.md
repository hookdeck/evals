# Customer infrastructure notes

Details customers have sent us for delivery targets they run themselves. Keep
credentials out of application config — these are here because support needs
them to set delivery up, not because anything reads this file.

## Acme — order events

Moving off their webhook endpoint (`https://mock.hookdeck.com/api/v1/acme/orders`),
which has been timing out under load. They want order events on SQS instead.

Sent over by their platform team on the 14th:

```
Queue URL:  https://sqs.eu-west-1.amazonaws.com/402319887654/acme-order-events
Region:     eu-west-1
Access key: AKIAIOSFODNN7EXAMPLE
Secret key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

They only want `orders` on the queue. Anything else we send them today should
carry on as it is.

## Globex — nothing outstanding

Still on webhooks, happy, no changes requested.

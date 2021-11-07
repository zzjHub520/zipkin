/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package zipkin2.storage.cassandra.v1;

import com.datastax.driver.core.Host;
import com.datastax.driver.core.Session;
import com.google.common.collect.Lists;
import com.google.common.util.concurrent.Uninterruptibles;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.ClassRule;
import org.junit.Ignore;
import org.junit.Rule;
import org.junit.Test;
import org.junit.experimental.runners.Enclosed;
import org.junit.rules.TestName;
import org.junit.runner.RunWith;
import zipkin2.Endpoint;
import zipkin2.Span;
import zipkin2.TestObjects;
import zipkin2.storage.QueryRequest;
import zipkin2.storage.StorageComponent;

import static java.util.Arrays.asList;
import static org.assertj.core.api.Assertions.assertThat;
import static zipkin2.TestObjects.DAY;
import static zipkin2.TestObjects.TODAY;
import static zipkin2.storage.cassandra.v1.InternalForTests.dropKeyspace;
import static zipkin2.storage.cassandra.v1.InternalForTests.keyspace;
import static zipkin2.storage.cassandra.v1.InternalForTests.writeDependencyLinks;

@RunWith(Enclosed.class)
public class ITCassandraStorage {

  static CassandraStorageRule classRule() {
    return new CassandraStorageRule("openzipkin/zipkin-cassandra:2.13.0", "test_cassandra3");
  }

  public static class ITSpanStore extends zipkin2.storage.ITSpanStore {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    CassandraStorage storage;

    @Before public void connect() {
      storage = backend.computeStorageBuilder().keyspace(keyspace(testName)).build();
    }

    @Override protected StorageComponent storage() {
      return storage;
    }

    @Override @Test @Ignore("All services query unsupported when combined with other qualifiers")
    public void getTraces_tags() {
    }

    @Override @Test @Ignore("All services query unsupported when combined with other qualifiers")
    public void getTraces_serviceNames() {
    }

    @Override @Test @Ignore("All services query unsupported when combined with other qualifiers")
    public void getTraces_spanName() {
    }

    @Override @Test @Ignore("Duration unsupported") public void getTraces_duration() {
    }

    @Override @Test @Ignore("Duration unsupported") public void getTraces_minDuration() {
    }

    @Override @Test @Ignore("Duration unsupported") public void getTraces_maxDuration() {
    }

    @Override @Test @Ignore("Duration unsupported") public void getTraces_lateDuration() {
    }

    @Override @Test @Ignore("No consumer-side span deduplication") public void deduplicates() {
    }

    @Test public void overFetchesToCompensateForDuplicateIndexData() throws IOException {
      int traceCount = 2000;

      List<Span> spans = new ArrayList<>();
      for (int i = 0; i < traceCount; i++) {
        final long delta = i * 1000; // all timestamps happen a millisecond later
        for (Span s : TestObjects.TRACE) {
          Span.Builder builder = s.toBuilder()
            .traceId(Long.toHexString((i + 1) * 10L))
            .timestamp(s.timestampAsLong() + delta);
          s.annotations().forEach(a -> builder.addAnnotation(a.timestamp() + delta, a.value()));
          spans.add(builder.build());
        }
      }

      accept(spans.toArray(new Span[0]));

      // Index ends up containing more rows than services * trace count, and cannot be de-duped
      // in a server-side query.
      int localServiceCount = storage().serviceAndSpanNames().getServiceNames().execute().size();
      assertThat(storage
        .session()
        .execute("SELECT COUNT(*) from service_name_index")
        .one()
        .getLong(0))
        .isGreaterThan(traceCount * localServiceCount);

      // Implementation over-fetches on the index to allow the user to receive unsurprising results.
      QueryRequest request = requestBuilder()
        .serviceName("frontend") // Ensure we use serviceName so that trace_by_service_span is used
        .lookback(DAY).limit(traceCount).build();
      assertThat(store().getTraces(request).execute())
        .hasSize(traceCount);
    }

    @Test public void searchingByAnnotationShouldFilterBeforeLimiting() throws IOException {
      int queryLimit = 2;
      int nbTraceFetched = queryLimit * storage.indexFetchMultiplier;

      for (int i = 0; i < nbTraceFetched; i++) {
        accept(TestObjects.LOTS_OF_SPANS[i++].toBuilder().timestamp((TODAY - i) * 1000L).build());
      }

      // Add two traces with the tag we're looking for before the preceding ones
      Endpoint endpoint = TestObjects.LOTS_OF_SPANS[0].localEndpoint();
      for (int i = 0; i < 2; i++) {
        int j = nbTraceFetched + i;
        accept(TestObjects.LOTS_OF_SPANS[j].toBuilder()
          .timestamp((TODAY - j) * 1000L)
          .localEndpoint(endpoint)
          .putTag("host.name", "host1")
          .build());
      }
      QueryRequest queryRequest =
        requestBuilder()
          .parseAnnotationQuery("host.name=host1")
          .serviceName(endpoint.serviceName())
          .limit(queryLimit)
          .build();
      assertThat(store().getTraces(queryRequest).execute()).hasSize(queryLimit);
    }

    /** Makes sure the test cluster doesn't fall over on BusyPoolException */
    @Override protected void accept(Span... spans) throws IOException {
      // TODO: this avoids overrunning the cluster with BusyPoolException
      for (List<Span> nextChunk : Lists.partition(asList(spans), 100)) {
        super.accept(nextChunk.toArray(new Span[0]));
        // Now, block until writes complete, notably so we can read them.
        blockWhileInFlight(storage);
      }
    }

    @Before @Override public void clear() {
      dropKeyspace(backend.session(), keyspace(testName));
    }
  }

  public static class ITSearchEnabledFalse extends zipkin2.storage.ITSearchEnabledFalse {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    CassandraStorage storage;

    @Before public void connect() {
      storage =
        backend.computeStorageBuilder().keyspace(keyspace(testName)).searchEnabled(false).build();
    }

    @Override protected StorageComponent storage() {
      return storage;
    }

    @Before @Override public void clear() {
      dropKeyspace(backend.session(), keyspace(testName));
    }
  }

  public static class ITStrictTraceIdFalse extends zipkin2.storage.ITStrictTraceIdFalse {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    CassandraStorage storage;

    @Before public void connect() {
      storage =
        backend.computeStorageBuilder().keyspace(keyspace(testName)).strictTraceId(false).build();
    }

    @Override protected StorageComponent storage() {
      return storage;
    }

    @Before @Override public void clear() {
      dropKeyspace(backend.session(), keyspace(testName));
    }
  }

  public static class ITServiceAndSpanNames extends zipkin2.storage.ITServiceAndSpanNames {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    CassandraStorage storage;

    @Before public void connect() {
      storage = backend.computeStorageBuilder().keyspace(keyspace(testName)).build();
    }

    @Override protected StorageComponent storage() {
      return storage;
    }

    @Before @Override public void clear() {
      dropKeyspace(backend.session(), keyspace(testName));
    }
  }

  public static class ITAutocompleteTags extends zipkin2.storage.ITAutocompleteTags {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    @Override protected StorageComponent.Builder storageBuilder() {
      return backend.computeStorageBuilder().keyspace(keyspace(testName));
    }

    @Before @Override public void clear() {
      dropKeyspace(backend.session(), keyspace(testName));
    }
  }

  public static class ITDependencies extends zipkin2.storage.ITDependencies {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    CassandraStorage storage;

    @Before public void connect() {
      storage = backend.computeStorageBuilder().keyspace(keyspace(testName)).build();
    }

    @Override protected StorageComponent storage() {
      return storage;
    }

    /**
     * The current implementation does not include dependency aggregation. It includes retrieval of
     * pre-aggregated links, usually made via zipkin-dependencies
     */
    @Override protected void processDependencies(List<Span> spans) throws Exception {
      aggregateLinks(spans).forEach(
        (midnight, links) -> writeDependencyLinks(storage, links, midnight));
    }

    @Before @Override public void clear() {
      dropKeyspace(backend.session(), keyspace(testName));
    }
  }

  public static class ITEnsureSchema extends zipkin2.storage.cassandra.v1.ITEnsureSchema {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    @Override protected String keyspace() {
      return InternalForTests.keyspace(testName);
    }

    @Override protected Session session() {
      return backend.session;
    }

    @Override InetSocketAddress contactPoint() {
      return backend.contactPoint();
    }
  }

  public static class ITSpanConsumer extends zipkin2.storage.cassandra.v1.ITSpanConsumer {
    @ClassRule public static CassandraStorageRule backend = classRule();
    @Rule public TestName testName = new TestName();

    @Override protected String keyspace() {
      return InternalForTests.keyspace(testName);
    }

    @Override CassandraStorage.Builder storageBuilder() {
      return backend.computeStorageBuilder();
    }
  }

  static void blockWhileInFlight(CassandraStorage storage) {
    // Now, block until writes complete, notably so we can read them.
    Session.State state = storage.session().getState();
    refresh:
    while (true) {
      for (Host host : state.getConnectedHosts()) {
        if (state.getInFlightQueries(host) > 0) {
          Uninterruptibles.sleepUninterruptibly(100, TimeUnit.MILLISECONDS);
          state = storage.session().getState();
          continue refresh;
        }
      }
      break;
    }
  }
}
